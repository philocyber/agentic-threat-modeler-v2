import { ProviderBillingError } from '@/lib/llm/provider-errors'
import { assertRunCostBudget, emptyUsage, runWithUsage } from '@/lib/llm/usage'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  buildRAGPrefetchRequest,
  classifyRetryError,
  computeRetryDelayMs,
  extractRetryAfterMs,
  getBestEffortParseCount,
  invokeAgentTwoPhase,
  mapSettledWithConcurrency,
  invokeStructuredWithRetry,
  gatherEvidenceNotes,
  resetBestEffortParseCount,
} from '@/lib/agents/base'
import { deduplicateRawThreats } from '@/lib/agents/dedup'
import { runDreadValidator } from '@/lib/agents/dread-validator'
import { synthesisBatchSchema, synthesisPlanningSchema } from '@/lib/agents/threat-synthesizer'
import { StructuredOutputError, StructuredOutputTimeoutError } from '@/lib/llm/structured'
import type { RawThreat, UnifiedThreat } from '@/lib/models/types'
import { makePassage } from '@/lib/rag/evidence'

// ─── Fakes ────────────────────────────────────────────────────────────────────

type CapturedCall = { system: string; user: string }

/** Minimal fake chat model (prompt-fallback mechanism): records calls, delegates responses. */
function fakeLLM(
  handler: (call: CapturedCall, callIndex: number) => Promise<unknown> | unknown,
): { model: BaseChatModel; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const model = {
    invoke: async (messages: Array<{ content: unknown }>) => {
      const call: CapturedCall = {
        system: String(messages[0]?.content ?? ''),
        user: String(messages[messages.length - 1]?.content ?? ''),
      }
      calls.push(call)
      return handler(call, calls.length - 1)
    },
  } as unknown as BaseChatModel
  return { model, calls }
}

function textResponse(text: string) {
  return { content: text }
}

const ThreatsSchema = z.object({
  threats: z.array(z.object({ title: z.string(), severity: z.enum(['low', 'medium', 'high']) })),
})
const VALID = { threats: [{ title: 'Spoofing the agent', severity: 'high' as const }] }

// ─── Error classification ─────────────────────────────────────────────────────

describe('classifyRetryError', () => {
  it('classifies billing-suspended 429s as non-retryable', () => {
    const err = Object.assign(
      new Error('429 Your account is suspended due to insufficient balance, please recharge your account'),
      { status: 429 },
    )
    expect(classifyRetryError(err)).toBe('client_error')
  })

  it('classifies 429 as rate_limit and honors Retry-After', () => {
    const err = Object.assign(new Error('Too Many Requests'), {
      status: 429,
      headers: { 'retry-after': '7' },
    })
    expect(classifyRetryError(err)).toBe('rate_limit')
    expect(extractRetryAfterMs(err)).toBe(7000)
    expect(computeRetryDelayMs(err, 1)).toBe(7000)
  })

  it('reads Retry-After from Headers-like objects and error.cause', () => {
    const headers = new Headers({ 'Retry-After': '3' })
    const err = Object.assign(new Error('429'), { status: 429, headers })
    expect(extractRetryAfterMs(err)).toBe(3000)

    const nested = new Error('boom', {
      cause: Object.assign(new Error('rate limited'), { status: 429, headers: { 'Retry-After': '2' } }),
    })
    expect(classifyRetryError(nested)).toBe('rate_limit')
    expect(extractRetryAfterMs(nested)).toBe(2000)
  })

  it('classifies 5xx as server with exponential backoff + jitter', () => {
    const err = Object.assign(new Error('Internal Server Error'), { status: 503 })
    expect(classifyRetryError(err)).toBe('server')
    const d1 = computeRetryDelayMs(err, 1)
    const d3 = computeRetryDelayMs(err, 3)
    expect(d1).toBeGreaterThanOrEqual(750) // 1000 * 0.75 jitter floor
    expect(d1).toBeLessThanOrEqual(1250)
    expect(d3).toBeGreaterThanOrEqual(3000) // 1000 * 2^2 * 0.75
    expect(d3).toBeLessThanOrEqual(5000)
  })

  it('classifies structured-output timeouts as timeout', () => {
    expect(classifyRetryError(new StructuredOutputTimeoutError('agent', 1000))).toBe('timeout')
  })

  it('classifies network failures from message text', () => {
    expect(classifyRetryError(new Error('fetch failed'))).toBe('network')
    expect(classifyRetryError(new Error('Did not receive done or success response in stream.'))).toBe('network')
    expect(classifyRetryError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe('network')
  })

  it('treats non-429 4xx as non-retryable client_error', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 })
    expect(classifyRetryError(err)).toBe('client_error')
    expect(computeRetryDelayMs(err, 1)).toBe(0)
  })

  it('recognizes Bedrock throttling before its generic HTTP 400 wrapper', () => {
    const err = Object.assign(new Error('rate exceeded'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
    })
    expect(classifyRetryError(err)).toBe('rate_limit')
  })

  it('reads Bedrock $metadata and does not retry unknown errors', () => {
    expect(classifyRetryError(Object.assign(new Error('service problem'), {
      $metadata: { httpStatusCode: 503 },
    }))).toBe('server')
    expect(classifyRetryError(new Error('provider returned an unexplained shape'))).toBe('unknown')
  })
})

// ─── Structured emission with retry ───────────────────────────────────────────

describe('invokeStructuredWithRetry', () => {
  it('retries from the original evidence and schema issues without echoing a large rejected object', async () => {
    const schema = z.object({ notes: z.string(), count: z.number(), tail: z.string() })
    const rejected = { notes: 'Keep this valid supporting qualification. '.repeat(150), count: 'wrong-type', tail: 'LATE_CANDIDATE_TO_REPAIR' }
    const { model, calls } = fakeLLM((_call, index) => textResponse(JSON.stringify(index === 0
      ? rejected : { ...rejected, count: 1 })))
    const actual = await invokeStructuredWithRetry({ llm: model, schema, systemPrompt: 'Use the source.',
      userMessage: 'Original evidence.', agentName: 'FullRepairContextTest', maxRetries: 2 })
    expect(actual.count).toBe(1)
    expect(calls).toHaveLength(2)
    const repair = calls[1]!.user
    expect(repair).toContain('Original evidence.')
    expect(repair).toContain('count: Invalid input: expected number, received string')
    expect(repair).not.toContain('LATE_CANDIDATE_TO_REPAIR')
    expect(repair).not.toContain('Keep this valid supporting qualification.')
  })

  it('retries synthesis with feedback when a response references a candidate outside its batch', async () => {
    let attempt = 0
    const { model, calls } = fakeLLM(() => {
      attempt++
      return textResponse(JSON.stringify({ threats: [{
        sourceCandidateIds: [attempt === 1 ? 'STRIDE-1' : 'STRIDE-01'],
        disposition: 'conditional', preconditions: ['Verify the authorization boundary.'], component: 'API', methodology: 'STRIDE',
        description: 'A caller with access to the API may cross an authorization boundary if the documented policy is not enforced for the requested resource.',
        impact: 'Access to another resource.', mitigation: 'Verify resource authorization.',
        dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5, total: 5 },
        priority: 'medium', confidenceScore: 0.6, evidenceSources: [],
      }] }))
    })
    const result = await invokeStructuredWithRetry({
      llm: model, schema: synthesisBatchSchema(['STRIDE-01', 'PASTA-10']),
      systemPrompt: 'Preserve candidate references.', userMessage: 'Synthesize the batch.',
      agentName: 'SynthesisLineageTest', maxRetries: 2,
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.user).toContain('STRIDE-01')
    expect(result.threats[0]?.sourceCandidateIds).toEqual(['STRIDE-01'])
  })
  it('retries a Zod validation failure with the issues fed back into the prompt', async () => {
    const bad = { threats: [{ title: 42, severity: 'extreme' }] }
    const { model, calls } = fakeLLM((_call, i) =>
      textResponse(JSON.stringify(i === 0 ? bad : VALID)),
    )

    const out = await invokeStructuredWithRetry({
      llm: model,
      schema: ThreatsSchema,
      systemPrompt: 'sys',
      userMessage: 'emit threats',
      agentName: 'test',
      maxRetries: 3,
    })

    expect(out).toEqual(VALID)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.user).toContain('VALIDATION FEEDBACK')
    expect(calls[1]?.user).toContain('threats.0.title')
  })

  it('retries a 429 with Retry-After and succeeds without re-prompting', async () => {
    const rateLimited = Object.assign(new Error('Too Many Requests'), {
      status: 429,
      headers: { 'retry-after': '0' },
    })
    const { model, calls } = fakeLLM((_call, i) => {
      if (i < 1) throw rateLimited
      return textResponse(JSON.stringify(VALID))
    })

    const out = await invokeStructuredWithRetry({
      llm: model,
      schema: ThreatsSchema,
      systemPrompt: 'sys',
      userMessage: 'emit threats',
      agentName: 'test',
      maxRetries: 3,
    })

    expect(out).toEqual(VALID)
    expect(calls).toHaveLength(2)
    // No validation feedback on provider errors
    expect(calls[1]?.user).not.toContain('VALIDATION FEEDBACK')
  })

  it('does not retry non-429 4xx errors', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 })
    const { model, calls } = fakeLLM(() => {
      throw unauthorized
    })

    const err = await invokeStructuredWithRetry({
      llm: model,
      schema: ThreatsSchema,
      systemPrompt: 'sys',
      userMessage: 'emit threats',
      agentName: 'test',
      maxRetries: 3,
    }).catch((e) => e)

    expect(err).toBe(unauthorized)
    expect(calls).toHaveLength(1)
  })

  it('retries per-call timeouts and then gives up', async () => {
    const { model, calls } = fakeLLM(() => new Promise(() => {}))
    const err = await invokeStructuredWithRetry({
      llm: model,
      schema: ThreatsSchema,
      systemPrompt: 'sys',
      userMessage: 'emit threats',
      agentName: 'test',
      maxRetries: 2,
      timeoutMs: 50,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(StructuredOutputTimeoutError)
    expect(calls).toHaveLength(2)
  })

  it('recovers a bare array on the first call instead of paying for retries', async () => {
    resetBestEffortParseCount()
    // The model answered with the array itself rather than the {threats: [...]}
    // wrapper. This used to cost 2 structured attempts plus a free-text
    // fallback — three full generations to recover data already in hand.
    const { model, calls } = fakeLLM(() =>
      textResponse(JSON.stringify([{ title: 'x', severity: 'high' }])),
    )

    const out = await invokeStructuredWithRetry({
      llm: model,
      schema: ThreatsSchema,
      systemPrompt: 'sys',
      userMessage: 'emit threats',
      agentName: 'test',
      maxRetries: 2,
    })

    expect(out).toEqual({ threats: [{ title: 'x', severity: 'high' }] })
    expect(calls).toHaveLength(1)
    expect(getBestEffortParseCount()).toBe(0)
    resetBestEffortParseCount()
  })

  it('still exhausts structured retries without a free-text fallback when the payload is unrecoverable', async () => {
    resetBestEffortParseCount()
    const { model, calls } = fakeLLM(() => textResponse(JSON.stringify({ threats: 'not-a-list' })))

    await expect(
      invokeStructuredWithRetry({
        llm: model,
        schema: ThreatsSchema,
        systemPrompt: 'sys',
        userMessage: 'emit threats',
        agentName: 'test',
        maxRetries: 2,
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError)
    expect(calls).toHaveLength(2)
    expect(getBestEffortParseCount()).toBe(0)
    resetBestEffortParseCount()
  })
})

// ─── Two-phase pattern ────────────────────────────────────────────────────────

describe('invokeAgentTwoPhase', () => {
  it('requires a bounded plan for every candidate and valid source references', () => {
    const schema = synthesisPlanningSchema(['C1', 'C2'], ['SRC-1'], 2000)
    const entry = { decision: 'verify', mergeWith: [], sourceIds: ['SRC-1'], note: 'Control configuration is unknown.' }
    const plan = { candidates: { C1: entry, C2: entry }, deduplication: '', gaps: '', evidenceGap: '' }
    expect(schema.safeParse(plan).success).toBe(true)
    expect(schema.safeParse({ ...plan, candidates: { C1: entry } }).success).toBe(false)
    expect(schema.safeParse({ ...plan, candidates: { ...plan.candidates, invented: entry } }).success).toBe(false)
    expect(z.toJSONSchema(schema, { io: 'input' }).additionalProperties).toBe(false)
    expect(schema.safeParse({ ...plan, candidates: { ...plan.candidates, C2: { ...entry, sourceIds: ['invented'] } } }).success).toBe(false)
    expect(schema.safeParse({ ...plan, candidates: { ...plan.candidates, C2: { ...entry, note: 'x'.repeat(161) } } }).success).toBe(false)
    expect(schema.parse({ ...plan, deduplication: 'x'.repeat(400) }).deduplication).toHaveLength(180)
    expect(schema.parse({ ...plan, gaps: 'y'.repeat(400) }).gaps).toHaveLength(160)
    expect(schema.parse({ ...plan, evidenceGap: 'z'.repeat(400) }).evidenceGap).toHaveLength(250)
  })

  it('keeps original source and one bounded retrieval follow-up in structured planning', async () => {
    let queries = 0
    const p = makePassage({ id: 'grants', domain: 'corporate', source: 'grants.md', document: 'REPORTER can only SELECT from REPORTING.', metadata: {} }, 'q2')
    const plan = { candidates: { C1: { decision: 'verify', mergeWith: [], sourceIds: ['SRC-1'], note: 'Effective grants unknown.' } }, deduplication: '', gaps: '', evidenceGap: 'What effective grants does REPORTER have on REPORTING?' }
    const revised = { ...plan, candidates: { C1: { ...plan.candidates.C1, note: 'Only SELECT is documented.' } } }
    const { model, calls } = fakeLLM((_call, index) => textResponse(JSON.stringify(index === 0 ? plan : revised)))
    const result = await gatherEvidenceNotes({ llm: model,
      tools: [{ invoke: async () => { queries++; return JSON.stringify({ version: 2, queryId: `q${queries}`, status: 'retrieved', passages: [p] }) } }] as never,
      outputSchema: synthesisPlanningSchema(['C1'], ['SRC-1'], 2000), systemPrompt: 'Plan', task: 'Review permissions',
      untrusted: 'SRC-1: Original REPORTER architecture.', agentName: 'structured-plan' })
    expect(JSON.parse(result)).toEqual(revised)
    expect(queries).toBe(1)
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.user).toContain('SRC-1: Original REPORTER architecture.')
    expect(calls[1]!.user).toContain(p.citationId)
    expect(calls[1]!.user).toContain('REPORTER can only SELECT')
  })

  it('preserves complete initial notes when an optional evidence revision truncates', async () => {
    let queries = 0
    const p = makePassage({ id: 'late-control', domain: 'technical', source: 'controls.md', document: 'A relevant control exists but its deployment status is unknown.', metadata: {} }, 'q2')
    const initial = 'Component: Review API\nThreat: Authorization enforcement is unverified.\nEVIDENCE_GAP: Is the authorization control deployed on Review API?'
    const { model, calls } = fakeLLM((_call, index) => index === 0
      ? textResponse(initial)
      : { content: 'Incomplete revised notes', response_metadata: { done_reason: 'length' } })
    const notes = await gatherEvidenceNotes({
      llm: model,
      tools: [{ invoke: async () => {
        queries++
        return JSON.stringify({ version: 2, queryId: `q${queries}`, status: 'retrieved', passages: [p] })
      } }] as never,
      systemPrompt: 'Analyze authorization.', task: 'Review permissions', untrusted: 'Review API architecture.',
      agentName: 'truncated-followup', maxRetries: 1,
    })
    expect(queries).toBe(1)
    expect(calls).toHaveLength(2)
    expect(notes).toContain('Authorization enforcement is unverified.')
    expect(notes).toContain('Unresolved evidence question: Is the authorization control deployed on Review API?')
    expect(notes).not.toContain('Incomplete revised notes')
  })

  it('supplies the original passage to emission even when the notes omit its qualifier', async () => {
    const p = makePassage({ id: 'late', domain: 'corporate', source: 'memory.md', document: `${'Memory context. '.repeat(40)}Isolation is unknown, not absent.`, metadata: {} }, 'q1')
    const { model, calls } = fakeLLM((_call, index) => textResponse(index === 0
      ? 'Memory risk notes without the qualification.\nEVIDENCE_GAP: What does memory.md say about isolation in this system?'
      : index === 1 ? 'Memory risk notes; isolation remains unknown.' : JSON.stringify(VALID)))
    await invokeAgentTwoPhase({ llm: model, tools: [{ invoke: async () => JSON.stringify({ version: 2, queryId: 'q1', status: 'retrieved', passages: [p] }) }] as never,
      evidenceSystemPrompt: 'Analyze', evidenceTask: 'Analyze memory', emissionSystemPrompt: 'Emit', emissionTask: 'Emit findings',
      buildEmissionUntrusted: notes => notes, schema: ThreatsSchema, agentName: 'passage-preservation' })
    expect(calls).toHaveLength(3)
    expect(calls[2]!.user).toContain('Isolation is unknown, not absent.')
    expect(calls[2]!.user).toContain(p.citationId)
    expect(calls[2]!.user).toContain('untrusted-retrieved-evidence')
  })

  it('queries one material gap and never loops on a second gap', async () => {
    let queries = 0
    const p = makePassage({ id: 'grants', domain: 'corporate', source: 'grants.md', document: 'Role REPORTER can only SELECT from REPORTING.', metadata: {} }, 'q2')
    const { model, calls } = fakeLLM((_call, index) => textResponse(index === 0 ? 'Grants unknown.\nEVIDENCE_GAP: What effective grants does REPORTER have on REPORTING?' : index === 1 ? `Found exact grants ${p.citationId}.\nEVIDENCE_GAP: Another question must not trigger a third search` : JSON.stringify(VALID)))
    await invokeAgentTwoPhase({ llm: model, tools: [{ invoke: async () => { queries++; return JSON.stringify({ version: 2, queryId: `q${queries}`, status: 'retrieved', passages: [p] }) } }] as never,
      evidenceSystemPrompt: 'Analyze', evidenceTask: 'Analyze permissions', emissionSystemPrompt: 'Emit', emissionTask: 'Emit findings', buildEmissionUntrusted: notes => notes,
      schema: ThreatsSchema, agentName: 'bounded-followup' })
    expect(queries).toBe(1)
    expect(calls).toHaveLength(3)
    expect(calls[2]!.user).toContain('only SELECT from REPORTING')
  })
  it('builds prefetch facets from the current step payload', () => {
    const request = buildRAGPrefetchRequest({
      agentName: 'DreadValidator',
      task: 'Validate the current threat batch',
      untrusted: 'Component: Payments API\nThreat: JWT audience bypass\nControl: issuer validation enabled',
    })

    expect(request.query).toBe('DreadValidator: Validate the current threat batch')
    expect(request.facets).toEqual([
      'Component: Payments API',
      'Threat: JWT audience bypass',
      'Control: issuer validation enabled',
    ])
  })

  it.each(['kimi', 'google', 'ollama', 'bedrock', 'cursor'])(
    'does not query optional RAG without an evidence gap for %s', async (provider) => {
      let queries = 0
      const { model, calls } = fakeLLM(() => textResponse('Architecture-supported analysis; no unresolved factual question.'))
      Object.assign(model, { providerName: provider })
      const notes = await gatherEvidenceNotes({
        llm: model,
        tools: [{ name: 'rag', invoke: async () => { queries++; return 'unused' } } as never],
        systemPrompt: 'Analyze the architecture.', task: 'Find supported threats',
        untrusted: 'The API crosses a trust boundary.', agentName: 'optional-rag', maxRetries: 1,
      })
      expect(notes).toContain('Architecture-supported analysis')
      expect(calls).toHaveLength(1)
      expect(queries).toBe(0)
    },
  )

  it('queries RAG once only after the model identifies a concrete evidence gap', async () => {
    let queries = 0
    const passage = makePassage({ id: 'authorization', domain: 'technical', source: 'authorization.md',
      document: 'The architecture must verify authorization at the API boundary.', metadata: {} }, 'q1')
    const { model, calls } = fakeLLM((_call, index) => textResponse(index === 0
      ? 'Component: API\nThreat: Authorization enforcement is unclear.\nEVIDENCE_GAP: Is API authorization enforced at the trust boundary?'
      : 'Component: API\nThreat: Authorization enforcement remains unverified.'))
    const notes = await gatherEvidenceNotes({
      llm: model,
      tools: [{ name: 'rag', invoke: async () => {
        queries++
        return JSON.stringify({ version: 2, queryId: 'q1', status: 'retrieved', passages: [passage] })
      } } as never],
      systemPrompt: 'Analyze the architecture.', task: 'Find supported threats',
      untrusted: 'The API crosses a trust boundary.', agentName: 'optional-rag-gap', maxRetries: 1,
    })
    expect(queries).toBe(1)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.user).toContain(passage.citationId)
    expect(notes).toContain('remains unverified')
  })

  it('carries a retrieved passage into emission and verifies a RAG citation when used', async () => {
    const passage = makePassage({ id: 'authorization', domain: 'technical', source: 'authorization.md',
      document: 'Authorization is checked at the API boundary.', metadata: {} }, 'q1')
    const findingSchema = z.object({ threats: z.array(z.object({
      component: z.string(), description: z.string(), confidenceScore: z.number(),
      evidenceSources: z.array(z.object({ sourceType: z.enum(['architecture', 'rag']), sourceName: z.string(), excerpt: z.string() })),
    })) })
    const { model, calls } = fakeLLM((_call, index) => textResponse(index === 0
      ? 'API authorization coverage is unclear.\nEVIDENCE_GAP: Is authorization checked at the API boundary?'
      : index === 1 ? 'The retrieved passage documents the API boundary check.'
        : JSON.stringify({ threats: [{ component: 'API', description: 'Authorization coverage requires verification.', confidenceScore: 0.65,
          evidenceSources: [{ sourceType: 'rag', sourceName: passage.citationId, excerpt: 'Authorization is checked' }] }] })))
    const result = await invokeAgentTwoPhase({ llm: model,
      tools: [{ invoke: async () => JSON.stringify({ version: 2, queryId: 'q1', status: 'retrieved', passages: [passage] }) }] as never,
      evidenceSystemPrompt: 'Analyze', evidenceTask: 'Review API', emissionSystemPrompt: 'Emit', emissionTask: 'Emit findings',
      buildEmissionUntrusted: notes => notes, schema: findingSchema, agentName: 'rag-citation-check' })
    expect(calls[2]?.user).toContain(passage.citationId)
    expect(result.threats[0]?.evidenceSources[0]).toMatchObject({
      citationId: passage.citationId, referenceStatus: 'verified', excerpt: passage.excerpt,
    })
  })

  it('retries an invented RAG citation but accepts an architecture-only correction', async () => {
    const findingSchema = z.object({ threats: z.array(z.object({
      component: z.string(), description: z.string(), confidenceScore: z.number(),
      evidenceSources: z.array(z.object({ sourceType: z.enum(['architecture', 'rag']), sourceName: z.string(), excerpt: z.string() })),
    })) })
    const finding = { component: 'API', description: 'Check API authorization scope.', confidenceScore: 0.65 }
    const { model, calls } = fakeLLM((_call, index) => textResponse(index === 0
      ? 'Analyze the API from its architecture.'
      : JSON.stringify({ threats: [{ ...finding, evidenceSources: index === 1
        ? [{ sourceType: 'rag', sourceName: 'RAG-aaaaaaaaaaaaaaaaaaaaaaaa', excerpt: 'Invented evidence.' }]
        : [] }] })))
    const result = await invokeAgentTwoPhase({ llm: model, tools: [],
      evidenceSystemPrompt: 'Analyze', evidenceTask: 'Review API', emissionSystemPrompt: 'Emit', emissionTask: 'Emit findings',
      buildEmissionUntrusted: notes => notes, schema: findingSchema, agentName: 'rag-citation-retry' })
    expect(calls).toHaveLength(3)
    expect(calls[2]?.user).toContain('RAG reference was not delivered')
    expect(result.threats[0]?.evidenceSources).toEqual([])
  })

  it('runs architecture-first evidence then structured emission without an unnecessary retrieval', async () => {
    const ragRequests: Array<{ query: string; facets?: string[] }> = []
    const notes = 'Component: API\nThreat: IDOR on /users/:id\nConfidence: 0.9'
    const { model, calls } = fakeLLM((_call, i) =>
      textResponse(i === 0 ? notes : JSON.stringify(VALID)),
    )

    const out = await invokeAgentTwoPhase({
      llm: model,
      tools: [{
        name: 'rag',
        invoke: async (request: { query: string; facets?: string[] }) => {
          ragRequests.push(request)
          return '[TECH] Access-control guidance'
        },
      } as never],
      evidenceSystemPrompt: 'EVIDENCE: produce prose notes',
      evidenceTask: 'analyze this architecture',
      emissionSystemPrompt: 'EMIT structured output',
      emissionTask: 'Emit now.',
      buildEmissionUntrusted: (n: string) => `Notes:\n${n}`,
      schema: ThreatsSchema,
      agentName: 'two-phase-test',
      maxRetries: 2,
    })

    expect(out).toEqual(VALID)
    expect(calls[0]?.system).toContain('EVIDENCE: produce prose notes')
    expect(calls[0]?.user).not.toContain('untrusted-retrieved-evidence')
    expect(ragRequests).toEqual([])
    expect(calls).toHaveLength(2)
    expect(calls[1]?.system).toContain('EMIT structured output')
    expect(calls[1]?.user).toContain('IDOR on /users/:id')
  })

  it('continues structured emission from the authoritative payload when optional evidence fails', async () => {
    const { model: evidenceLLM, calls: evidenceCalls } = fakeLLM(() => {
      throw new StructuredOutputTimeoutError('fallback-test', 50)
    })
    const { model: emissionLLM, calls: emissionCalls } = fakeLLM(() =>
      textResponse(JSON.stringify(VALID)),
    )

    const out = await invokeAgentTwoPhase({
      llm: emissionLLM,
      evidenceLLM,
      tools: [],
      evidenceSystemPrompt: 'EVIDENCE',
      evidenceTask: 'analyze',
      evidenceUntrusted: 'authoritative architecture',
      emissionSystemPrompt: 'EMIT',
      emissionTask: 'emit',
      buildEmissionUntrusted: (notes) => `${notes}\n\nAuthoritative: API Gateway`,
      schema: ThreatsSchema,
      agentName: 'fallback-test',
      evidenceMaxRetries: 1,
      continueOnEvidenceFailure: true,
    })

    expect(out).toEqual(VALID)
    expect(evidenceCalls).toHaveLength(1)
    expect(emissionCalls).toHaveLength(1)
    expect(emissionCalls[0]?.user).toContain('Evidence enrichment was unavailable')
    expect(emissionCalls[0]?.user).toContain('Authoritative: API Gateway')
  })

  it('never converts cancellation into an evidence fallback', async () => {
    const abort = new Error('cancelled')
    abort.name = 'AbortError'
    const { model: evidenceLLM } = fakeLLM(() => {
      throw abort
    })
    const { model: emissionLLM, calls: emissionCalls } = fakeLLM(() =>
      textResponse(JSON.stringify(VALID)),
    )

    await expect(invokeAgentTwoPhase({
      llm: emissionLLM,
      evidenceLLM,
      tools: [],
      evidenceSystemPrompt: 'EVIDENCE',
      evidenceTask: 'analyze',
      emissionSystemPrompt: 'EMIT',
      emissionTask: 'emit',
      buildEmissionUntrusted: (notes) => notes,
      schema: ThreatsSchema,
      agentName: 'abort-test',
      evidenceMaxRetries: 1,
      continueOnEvidenceFailure: true,
    })).rejects.toBe(abort)
    expect(emissionCalls).toHaveLength(0)
  })

  it('does not re-run evidence when emission validation retries', async () => {
    const bad = { threats: [{ title: 1, severity: 'nope' }] }
    const { model, calls } = fakeLLM((_call, i) => {
      if (i === 0) return textResponse('notes')
      return textResponse(JSON.stringify(i === 1 ? bad : VALID))
    })

    const out = await invokeAgentTwoPhase({
      llm: model,
      tools: [{ name: 'rag', invoke: async () => '[TECH] evidence' } as never],
      evidenceSystemPrompt: 'EVIDENCE',
      evidenceTask: 'arch',
      emissionSystemPrompt: 'EMIT',
      emissionTask: 'emit',
      buildEmissionUntrusted: (n: string) => n,
      schema: ThreatsSchema,
      agentName: 'two-phase-retry',
      maxRetries: 3,
    })

    expect(out).toEqual(VALID)
    expect(calls).toHaveLength(3)
    expect(calls[2]?.user).toContain('VALIDATION FEEDBACK')
  })

  it('bounds verbose evidence notes before structured emission', async () => {
    const { model, calls } = fakeLLM((_call, i) =>
      i === 0
        ? textResponse(`primary finding\n\n${'x'.repeat(1_000)}`)
        : textResponse(JSON.stringify(VALID)),
    )

    await invokeAgentTwoPhase({
      llm: model,
      tools: [{ name: 'rag', invoke: async () => '[TECH] evidence' } as never],
      evidenceSystemPrompt: 'EVIDENCE',
      evidenceTask: 'arch',
      emissionSystemPrompt: 'EMIT',
      emissionTask: 'emit',
      buildEmissionUntrusted: (notes: string) => notes,
      schema: ThreatsSchema,
      agentName: 'bounded-evidence',
      maxEvidenceCharacters: 120,
    })

    expect(calls[0]?.system).toContain('at most 120 characters total')
    expect(calls[1]?.user).toContain('complete evidence blocks omitted')
    expect(calls[1]?.user).not.toContain('x'.repeat(50))
    expect(calls[1]?.user).toContain('Do not reconstruct')
    expect(calls[1]?.user.length).toBeLessThan(300)
  })

  it('uses a caller-supplied retrieval hint only as a facet after an evidence gap', async () => {
    const ragRequests: Array<{ query: string; facets?: string[] }> = []
    const p = makePassage({ id: 'jwt', domain: 'technical', source: 'jwt.md', document: 'JWT audience validation is required at Kong Gateway.', metadata: {} }, 'q1')
    const { model } = fakeLLM((_call, index) => textResponse(index === 0
      ? 'JWT validation unknown.\nEVIDENCE_GAP: Does Kong Gateway validate JWT audience for this API?'
      : index === 1 ? 'JWT validation remains unknown.' : JSON.stringify(VALID)))

    await invokeAgentTwoPhase({
      llm: model,
      tools: [{
        name: 'rag',
        invoke: async (request: { query: string; facets?: string[] }) => {
          ragRequests.push(request)
          return JSON.stringify({ version: 2, queryId: 'q1', status: 'retrieved', passages: [p] })
        },
      } as never],
      evidenceSystemPrompt: 'EVIDENCE',
      evidenceTask: 'arch',
      evidenceUntrusted: 'system under review',
      prefetchQuery: 'Red team attack techniques for Kong Gateway unsigned JWT',
      emissionSystemPrompt: 'EMIT',
      emissionTask: 'emit',
      buildEmissionUntrusted: (notes: string) => notes,
      schema: ThreatsSchema,
      agentName: 'prefetch-override',
    })

    expect(ragRequests).toHaveLength(1)
    expect(ragRequests[0]?.query).toBe('Does Kong Gateway validate JWT audience for this API?')
    expect(ragRequests[0]?.facets).toContain('Red team attack techniques for Kong Gateway unsigned JWT')
  })

  it('skips optional RAG when no tools are attached', async () => {
    const { model, calls } = fakeLLM(() => textResponse('architecture-only notes'))
    const notes = await gatherEvidenceNotes({
      llm: model,
      tools: [],
      systemPrompt: 'EVIDENCE',
      task: 'analyze this architecture',
      agentName: 'no-rag',
      maxRetries: 1,
    })
    expect(notes).toBe('architecture-only notes')
    expect(calls).toHaveLength(1)
  })

  it('preserves architecture notes when an optional RAG lookup fails', async () => {
    const { model, calls } = fakeLLM(() => textResponse('Architecture notes remain valid.\nEVIDENCE_GAP: Is API authorization deployed at the boundary?'))
    const notes = await gatherEvidenceNotes({
      llm: model,
      tools: [{
        name: 'rag',
        invoke: async () => {
          throw new Error('nodes is not iterable')
        },
      } as never],
      systemPrompt: 'EVIDENCE',
      task: 'analyze this architecture',
      agentName: 'optional-rag-fail',
      maxRetries: 1,
    })
    expect(notes).toContain('Architecture notes remain valid.')
    expect(notes).toContain('Unresolved evidence question')
    expect(calls).toHaveLength(1)
  })

  it('does not enter a ReAct loop or query RAG without a gap', async () => {
    let queries = 0
    const { model, calls } = fakeLLM(() => textResponse('architecture-only notes'))
    const notes = await gatherEvidenceNotes({
      llm: model,
      tools: [{
        name: 'rag',
        invoke: async () => { queries++; return '[TECH] JWT bypass patterns' },
      } as never],
      systemPrompt: 'EVIDENCE',
      task: 'analyze this architecture',
      agentName: 'optional-rag-no-gap',
      maxRetries: 1,
    })
    expect(notes).toBe('architecture-only notes')
    expect(calls).toHaveLength(1)
    expect(queries).toBe(0)
  })

  it('times out a hung architecture-first evidence call', async () => {
    const { model } = fakeLLM(() => new Promise(() => {}))
    await expect(
      gatherEvidenceNotes({
        llm: model,
        tools: [{ name: 'rag', invoke: async () => '[TECH] ok' } as never],
        systemPrompt: 'EVIDENCE',
        task: 'analyze this architecture',
        agentName: 'hung-evidence',
        maxRetries: 1,
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(StructuredOutputTimeoutError)
  })
})

// ─── Dedup batch embeddings ───────────────────────────────────────────────────

describe('deduplicateRawThreats — batched embeddings', () => {
  function raw(partial: Partial<RawThreat> & Pick<RawThreat, 'description'>): RawThreat {
    return {
      component: partial.component ?? 'API',
      methodology: partial.methodology ?? 'STRIDE',
      impact: 'impact',
      mitigation: 'mitigation',
      confidenceScore: partial.confidenceScore ?? 0.8,
      evidenceSources: [{ sourceType: 'architecture', sourceName: 'arch', excerpt: 'x' }],
      ...partial,
    }
  }

  it('embeds N threats in ONE batch call and dedupes by cosine similarity', async () => {
    const threats = [
      raw({ description: 'SQL injection in login form' }),
      raw({ description: 'SQL injection in login form', confidenceScore: 0.9 }), // exact dupe
      raw({ description: 'Unencrypted PII at rest' }),
      raw({ description: 'Missing rate limiting on OTP' }),
      raw({ description: 'Broken object level authorization' }),
    ]

    let batchCalls = 0
    const embedBatch = async (texts: string[]): Promise<number[][]> => {
      batchCalls++
      // Deterministic: identical texts → identical unit vector (cosine 1),
      // distinct texts → orthogonal basis vectors (cosine 0).
      const basis = new Map<string, number[]>()
      return texts.map((t) => {
        let v = basis.get(t)
        if (!v) {
          v = new Array<number>(texts.length).fill(0)
          v[basis.size] = 1
          basis.set(t, v)
        }
        return v
      })
    }

    const { kept, stats } = await deduplicateRawThreats(threats, { embedBatch })

    expect(batchCalls).toBe(1)
    expect(stats.embeddingMode).toBe('embedding')
    expect(stats.embeddingDuplicates).toBe(1)
    expect(kept).toHaveLength(4)
    // Higher-confidence duplicate wins the merge
    const sql = kept.find((t) => t.description.includes('SQL injection'))
    expect(sql?.confidenceScore).toBe(0.9)
  })

  it('falls back to lexical when every embedding call fails', async () => {
    const threats = [
      raw({ description: 'SQL injection in login form allows credential bypass' }),
      raw({ description: 'SQL injection in login allows credential bypass attack' }),
    ]
    const embedBatch = async (): Promise<number[][]> => {
      throw new Error('ollama down')
    }

    const { kept, stats } = await deduplicateRawThreats(threats, { embedBatch })
    expect(stats.embeddingMode).toBe('lexical')
    expect(kept.length).toBeLessThanOrEqual(2)
  })
})

// ─── Validator concurrency ────────────────────────────────────────────────────

describe('runDreadValidator — parallel batches with bounded concurrency', () => {
  function unified(id: string): UnifiedThreat {
    return {
      id,
      component: 'API',
      methodology: 'STRIDE',
      description: `Threat description for ${id} with enough detail to be realistic`,
      impact: 'impact',
      mitigation: 'mitigation',
      dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5, total: 5 },
      priority: 'medium',
      confidenceScore: 0.8,
      evidenceSources: [],
    }
  }

  /**
   * Holds every call until `size` of them are in flight, so overlap is proven by
   * the runner rather than by racing a fixed sleep. The fallback only fires when
   * the code under test never reaches that concurrency, which is the failure the
   * assertions below are meant to catch.
   */
  function concurrencyBarrier(size: number, fallbackMs = 2000) {
    let waiting: Array<() => void> = []
    return () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve)
        if (waiting.length >= size) {
          const released = waiting
          waiting = []
          for (const release of released) release()
          return
        }
        setTimeout(() => {
          const index = waiting.indexOf(resolve)
          if (index >= 0) {
            waiting.splice(index, 1)
            resolve()
          }
        }, fallbackMs)
      })
  }

  it.each([{ provider: 'gemini', expected: 2 }, { provider: 'ollama', expected: 1 }, { provider: 'kimi', expected: 1 }])(
    'processes every batch with $expected concurrent calls for $provider', async ({ provider, expected }) => {
    const threats = Array.from({ length: 12 }, (_, i) => unified(`THR-${i + 1}`))

    let active = 0
    let maxActive = 0
    const barrier = concurrencyBarrier(expected)
    const { model } = fakeLLM(async (call) => {
      active++
      maxActive = Math.max(maxActive, active)
      await barrier()
      active--

      if (call.system.includes('DREAD SCORING GRID')) {
        // Emission call: echo one validation per ID found in the user message
        const ids = [...call.user.matchAll(/ID: (THR-\d+)/g)].map((m) => m[1])
        return textResponse(
          JSON.stringify({
            validations: ids.map((id) => ({
              id,
              title: `Pattern for ${id}`,
              description: `Adversary perspective description for ${id} threat scenario`,
              dread: { damage: 6, reproducibility: 6, exploitability: 6, affectedUsers: 6, discoverability: 6, total: 6 },
            })),
          }),
        )
      }
      // Evidence call: free-text notes
      return textResponse('NOTES: some analysis notes')
    })

    Object.assign(model, { providerName: provider })
    const out = await runDreadValidator(model, [], threats, { concurrency: 2 })

    expect(out).toHaveLength(12)
    expect(maxActive).toBe(expected)
    // Enrichment applied: titles and recomputed DREAD/priority
    expect(out[0]?.title).toBe('Pattern for THR-1')
    expect(out[0]?.dread.total).toBe(6)
    expect(out[0]?.priority).toBe('medium')
    // Budget covers the serial case: if the validator stopped running batches in
    // parallel every call would fall back, and the run must still reach the
    // assertions above instead of dying on the default 5s test timeout.
  }, 30_000)

  it('salvages successful DREAD batches and preserves only the failed batch', async () => {
    const threats = Array.from({ length: 7 }, (_, i) => unified(`THR-${i + 1}`))
    const { model } = fakeLLM(async (call) => {
      if (call.user.includes('THR-6')) throw new Error('provider rejected this batch')
      if (!call.system.includes('DREAD SCORING GRID')) return textResponse('NOTES: grounded')
      const ids = [...call.user.matchAll(/ID: (THR-\d+)/g)].map((match) => match[1])
      return textResponse(JSON.stringify({
        validations: ids.map((id) => ({
          id,
          title: `Enriched ${id}`,
          description: `Adversary perspective for ${id}`,
          dread: { damage: 6, reproducibility: 6, exploitability: 6, affectedUsers: 6, discoverability: 6, total: 6 },
        })),
      }))
    })
    const errors: string[] = []
    const out = await runDreadValidator(model, [], threats, {
      concurrency: 1,
      onBatchError: (error) => errors.push(error),
    })
    expect(out).toHaveLength(7)
    expect(out[0]).toMatchObject({ title: 'Enriched THR-1', dread: { total: 6 } })
    expect(out[5]).toMatchObject({ dread: { total: 5 } })
    expect(errors).toEqual([expect.stringMatching(/batch 2\/2 failed/i)])
  })

  it('starts local DREAD validation with batches of at most three findings', async () => {
    const processed: string[][] = []
    const { model } = fakeLLM(call => {
      if (!call.system.includes('DREAD SCORING GRID')) return textResponse('NOTES: assess each documented finding')
      const ids = [...new Set([...call.user.matchAll(/ID: (THR-\d+)/g)].map(match => match[1]!))]
      processed.push(ids)
      return textResponse(JSON.stringify({ validations: ids.map(id => ({ id, title: `Reviewed ${id}`,
        dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5 } })) }))
    })
    Object.assign(model, { providerName: 'ollama' })
    const originals = Array.from({ length: 7 }, (_, index) => unified(`THR-${index + 1}`))
    const result = await runDreadValidator(model, [], originals, { maxRetries: 1 })
    expect(processed.map(ids => ids.length)).toEqual([3, 3, 1])
    expect(result.map(threat => threat.title)).toEqual(originals.map(threat => `Reviewed ${threat.id}`))
  })

  it('preserves synthesis fields instead of accepting DREAD rewrites', async () => {
    const original = {
      ...unified('THR-1'),
      description: 'Original source-backed description.',
      impact: 'Original impact.',
      mitigation: 'Original mitigation.',
      traceability: { components: ['API'] },
    }
    const { model } = fakeLLM(call => textResponse(!call.system.includes('DREAD SCORING GRID')
      ? 'NOTES: score the original finding'
      : JSON.stringify({ validations: [{
        id: 'THR-1', title: 'Reviewed pattern', description: 'Invented rewrite', impact: 'Invented impact', mitigation: 'Invented mitigation',
        traceability: { components: ['Invented service'] },
        dread: { damage: 6, reproducibility: 6, exploitability: 6, affectedUsers: 6, discoverability: 6 },
      }] })))
    const [result] = await runDreadValidator(model, [], [original])
    expect(result).toMatchObject({
      title: 'Reviewed pattern',
      description: original.description,
      impact: original.impact,
      mitigation: original.mitigation,
      traceability: original.traceability,
    })
  })

  it('retries an incomplete validator response instead of silently accepting missing findings', async () => {
    let emissions = 0
    const { model } = fakeLLM(call => {
      if (!call.system.includes('DREAD SCORING GRID')) return textResponse('NOTES: review both threats')
      emissions++
      const ids = emissions === 1 ? ['THR-1'] : ['THR-1', 'THR-2']
      return textResponse(JSON.stringify({ validations: ids.map(id => ({ id, title: `Reviewed ${id}`, description: 'Conditional risk',
        dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5 } })) }))
    })
    const errors: string[] = []
    const result = await runDreadValidator(model, [], [unified('THR-1'), unified('THR-2')], { onBatchError: error => errors.push(error) })
    expect(emissions).toBe(2)
    expect(errors).toEqual([])
    expect(result.map(threat => threat.title)).toEqual(['Reviewed THR-1', 'Reviewed THR-2'])
  })

  it('splits a truncated validation batch and still assesses every original ID', async () => {
    const processed: string[][] = []
    const { model } = fakeLLM(call => {
      if (!call.system.includes('DREAD SCORING GRID')) return textResponse('NOTES: all original findings require assessment')
      const ids = [...new Set([...call.user.matchAll(/ID: (THR-\d+)/g)].map(match => match[1]!))]
      processed.push(ids)
      if (ids.length > 3) return { content: '{', response_metadata: { done_reason: 'length' } }
      return textResponse(JSON.stringify({ validations: ids.map(id => ({ id, title: `Reviewed ${id}`, description: 'Conditional risk',
        dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5 } })) }))
    })
    Object.assign(model, { providerName: 'gemini' })
    const errors: string[] = []
    const originals = Array.from({ length: 5 }, (_, index) => unified(`THR-${index + 1}`))
    const result = await runDreadValidator(model, [], originals, { maxRetries: 1, onBatchError: error => errors.push(error) })
    expect(processed.map(ids => ids.length)).toEqual([5, 3, 2])
    expect(errors).toEqual([])
    expect(result.map(threat => threat.title)).toEqual(originals.map(threat => `Reviewed ${threat.id}`))
  })

  it('reports zero placeholders as unscored even if the model calls them validated', async () => {
    const { model } = fakeLLM(call => textResponse(!call.system.includes('DREAD SCORING GRID') ? 'NOTES: controls unknown' : JSON.stringify({ validations: [{
      id: 'THR-1', title: 'Unresolved policy', description: 'Conditional risk', scoringStatus: 'validated',
      scoringRationale: 'Zero dimensions are storage placeholders, not assessed risk.',
      dread: { damage: 0, reproducibility: 0, exploitability: 0, affectedUsers: 0, discoverability: 0 },
    }] })))
    const errors: string[] = []
    const result = await runDreadValidator(model, [], [unified('THR-1')], { onBatchError: error => errors.push(error) })
    expect(result[0]?.scoringStatus).toBe('unscored')
    expect(errors).toEqual([expect.stringContaining('explicitly unscored')])
  })

  it('bounds an overlong scoring rationale without discarding the completed batch', async () => {
    const rationale = 'Dimension-specific evidence and unresolved assumptions. '.repeat(40)
    const { model } = fakeLLM(call => textResponse(!call.system.includes('DREAD SCORING GRID')
      ? 'NOTES: assess every DREAD dimension against the architecture.'
      : JSON.stringify({ validations: [{
        id: 'THR-1', title: 'Reviewed authorization boundary', scoringStatus: 'validated',
        scoringRationale: rationale,
        dread: { damage: 6, reproducibility: 5, exploitability: 4, affectedUsers: 5, discoverability: 6 },
      }] })))
    const errors: string[] = []

    const [result] = await runDreadValidator(model, [], [unified('THR-1')], {
      maxRetries: 1,
      onBatchError: error => errors.push(error),
    })

    expect(errors).toEqual([])
    expect(result?.title).toBe('Reviewed authorization boundary')
    expect(result?.scoringRationale).toHaveLength(1_200)
    expect(result?.dread.total).toBe(5.2)
  })
})


describe('source-backed two-phase evidence', () => {
  it('fits the note instruction to the evidence model output cap, not the larger emission model', async () => {
    const evidence = fakeLLM(() => textResponse('Complete candidate notes with the original qualification.'))
    const emission = fakeLLM(() => textResponse(JSON.stringify(VALID)))
    Object.assign(evidence.model, { contextWindow: 40960, outputTokenReserve: 4096 })
    Object.assign(emission.model, { contextWindow: 131072, outputTokenReserve: 16384 })
    const source = '[SRC-0001] ' + 'Original architecture qualification. '.repeat(1500) + '\n[/SRC-0001]'
    await invokeAgentTwoPhase({
      llm: emission.model, evidenceLLM: evidence.model, tools: [],
      evidenceSystemPrompt: 'Analyze evidence.', evidenceTask: 'Analyze.', evidenceUntrusted: source,
      emissionSystemPrompt: 'Emit.', emissionTask: 'Emit.', buildEmissionUntrusted: notes => notes + source,
      schema: ThreatsSchema, agentName: 'EvidenceCapacityTest', maxRetries: 1, preserveEvidenceNotes: true,
    })
    const budget = Number(evidence.calls[0]?.system.match(/Evidence note budget: at most (\d+) characters/)?.[1])
    expect(budget).toBeGreaterThan(0)
    expect(budget).toBeLessThanOrEqual(8192)
    expect(evidence.calls[0]?.user).toContain(source)
    expect(emission.calls[0]?.user).toContain(source)
    expect(emission.calls[0]?.user).toContain('Complete candidate notes with the original qualification.')
  })

  it('also respects evidence capacity when a caller supplies a larger character limit', async () => {
    const { model, calls } = fakeLLM((_call, index) => textResponse(index === 0 ? 'Complete notes.' : JSON.stringify(VALID)))
    Object.assign(model, { contextWindow: 32768, outputTokenReserve: 1024 })
    await invokeAgentTwoPhase({
      llm: model, tools: [], evidenceSystemPrompt: 'Analyze.', evidenceTask: 'Analyze.',
      evidenceUntrusted: '[SRC-0001] Original source.', emissionSystemPrompt: 'Emit.', emissionTask: 'Emit.',
      buildEmissionUntrusted: notes => notes, schema: ThreatsSchema, agentName: 'ExplicitEvidenceCapacityTest',
      maxRetries: 1, preserveEvidenceNotes: true, maxEvidenceCharacters: 32000,
    })
    const budget = Number(calls[0]?.system.match(/Evidence note budget: at most (\d+) characters/)?.[1])
    expect(budget).toBeGreaterThan(0)
    expect(budget).toBeLessThanOrEqual(2048)
  })

  it('preserves oversized returned notes instead of dropping late candidate evidence', async () => {
    const notes = '# Candidate one\n' + 'Original qualification. '.repeat(300) + '\nLate mandatory restriction.'
    const { model, calls } = fakeLLM((_call, index) => textResponse(index === 0 ? notes : JSON.stringify(VALID)))
    await invokeAgentTwoPhase({ llm: model, tools: [], evidenceSystemPrompt: 'Analyze evidence.', evidenceTask: 'Analyze.', evidenceUntrusted: '[SRC-0001] Original source.', emissionSystemPrompt: 'Emit.', emissionTask: 'Emit.', buildEmissionUntrusted: value => value, schema: ThreatsSchema, agentName: 'SourceTest', maxRetries: 1, preserveEvidenceNotes: true, maxEvidenceCharacters: 100 })
    expect(calls.at(-1)?.user).toContain('Late mandatory restriction.')
  })
  it('delivers original source follow-up to both revision and structured emission', async () => {
    const original = '[SRC-0006] Production identity cannot read another tenant; staging permissions differ.'
    const { model, calls } = fakeLLM((_call, index) => textResponse(index === 0 ? 'SOURCE_GAP: SRC-0006' : index === 1 ? 'Conditional finding: production is restricted; verify staging.' : JSON.stringify(VALID)))
    await invokeAgentTwoPhase({ llm: model, tools: [], evidenceSystemPrompt: 'Analyze.', evidenceTask: 'Analyze.', evidenceUntrusted: '[SRC-0001] Export workflow.', emissionSystemPrompt: 'Emit.', emissionTask: 'Emit.', buildEmissionUntrusted: value => value, schema: ThreatsSchema, agentName: 'SourceTest', maxRetries: 1, preserveEvidenceNotes: true, sourceLookup: () => original })
    expect(calls[1]?.user).toContain(original)
    expect(calls.at(-1)?.user).toContain(original)
    expect(calls.at(-1)?.user).toContain('verify staging')
  })
})


it('blocks structured emission when the model reports truncated evidence notes', async () => {
  const { model, calls } = fakeLLM(() => ({ content: 'Incomplete candidate with missing qualification', response_metadata: { finish_reason: 'length' } }))
  await expect(invokeAgentTwoPhase({ llm: model, tools: [], evidenceSystemPrompt: 'Analyze.', evidenceTask: 'Analyze.', evidenceUntrusted: '[SRC-0001] Original source.', emissionSystemPrompt: 'Emit.', emissionTask: 'Emit.', buildEmissionUntrusted: value => value, schema: ThreatsSchema, agentName: 'SourceTest', maxRetries: 1, preserveEvidenceNotes: true, continueOnEvidenceFailure: true })).rejects.toThrow(/truncated its evidence notes/)
  expect(calls).toHaveLength(1)
})


describe('fatal provider billing', () => {
  it('does not retry or emit after evidence billing failure, even with evidence fallback enabled', async () => {
    const { model, calls } = fakeLLM(() => { throw Object.assign(new Error('insufficient balance'), { status: 429 }) })
    await runWithUsage(emptyUsage(), async () => {
      await expect(invokeAgentTwoPhase({
        llm: model, tools: [], agentName: 'BillingTest', schema: ThreatsSchema,
        evidenceSystemPrompt: 'Gather evidence', evidenceTask: 'Analyze',
        emissionSystemPrompt: 'Emit', emissionTask: 'Emit', buildEmissionUntrusted: (notes) => notes,
        continueOnEvidenceFailure: true, maxRetries: 3,
      })).rejects.toThrow(ProviderBillingError)
      expect(() => assertRunCostBudget()).toThrow(ProviderBillingError)
    })
    expect(calls).toHaveLength(1)
  })

  it('stops queued batches on billing failure', async () => {
    const started: number[] = []
    await expect(mapSettledWithConcurrency([1, 2, 3], 1, async (item) => {
      started.push(item)
      throw new ProviderBillingError()
    })).rejects.toThrow(ProviderBillingError)
    expect(started).toEqual([1])
  })

  it('prevents a surviving concurrent worker from starting more batches after a fatal error', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const started: number[] = []
    const result = mapSettledWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      started.push(item)
      if (item === 1) throw new ProviderBillingError()
      await pending
      return item
    })
    await expect(result).rejects.toThrow(ProviderBillingError)
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual([1, 2])
  })
})
