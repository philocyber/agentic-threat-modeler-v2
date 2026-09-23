import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIMessageChunk } from '@langchain/core/messages'
import { z } from 'zod'
import { ChatBedrockConverse } from '@langchain/aws'
import { getConfig } from '@/lib/config'
import { getLLM, clearLLMCache } from '../factory'
import { invokeStructured, selectStructuredMechanism } from '../structured'
import { synthesisPlanningSchema } from '@/lib/agents/threat-synthesizer'
import { validatorBatchSchema } from '@/lib/agents/dread-validator'
import { debateBatchSchema, normalizeDebateAssessment } from '@/lib/agents/debate'
import { invokeAgentTwoPhase } from '@/lib/agents/base'

afterEach(() => { clearLLMCache(); vi.restoreAllMocks() })

describe('shared workflow contracts across inference providers', () => {
  it.each(['ollama', 'kimi', 'google', 'cursor', 'bedrock'] as const)(
    '%s keeps prose evidence separate from schema-constrained emission', async provider => {
      const config = getConfig()
      const llm = getLLM({ ...config, llm: { ...config.llm, provider,
        googleApiKey: 'test', kimiApiKey: 'test', cursorApiKey: 'test' } }, 'quick', false)
      const schema = z.object({ summary: z.string() })
      const notes = 'The architecture requires human approval; reviewer accuracy remains unknown.'
      const result = { summary: notes }
      const requests: Array<{ input: string; options: Record<string, unknown> }> = []
      if (provider === 'ollama') expect((llm as unknown as { format?: unknown }).format).toBeUndefined()
      if (provider === 'kimi') expect((llm as unknown as { invocationParams: () => Record<string, unknown> }).invocationParams().response_format).toBeUndefined()
      vi.spyOn(llm, 'invoke').mockImplementation(async (input, options) => {
        requests.push({ input: JSON.stringify(input), options: options as Record<string, unknown> })
        return new AIMessageChunk({ content: requests.length === 1 ? notes : JSON.stringify(result), response_metadata: { finish_reason: 'stop' } })
      })
      if (llm instanceof ChatBedrockConverse) {
        vi.spyOn(llm, 'withStructuredOutput').mockImplementation(received => {
          // The two-phase path adds delivered-RAG citation checks without
          // changing the provider-facing JSON shape or valid outputs.
          expect(z.toJSONSchema(received as z.ZodType)).toEqual(z.toJSONSchema(schema))
          expect((received as z.ZodType).safeParse(result).success).toBe(true)
          return { invoke: async (input: unknown) => {
            expect(JSON.stringify(input)).toContain(notes)
            return { raw: new AIMessageChunk({ content: JSON.stringify(result) }), parsed: schema.parse(result) }
          } } as never
        })
      }
      const actual = await invokeAgentTwoPhase({
        llm, tools: [], evidenceSystemPrompt: 'Review the source and write prose notes.',
        evidenceTask: 'Review.', evidenceUntrusted: '[SRC-0001] Human approval is required.',
        emissionSystemPrompt: 'Normalize the notes.', emissionTask: 'Return the summary.',
        buildEmissionUntrusted: value => value, schema, agentName: 'TwoPhaseProviderContract', maxRetries: 1,
      })
      expect(actual).toEqual(result)
      expect(requests[0]?.options.format).toBeUndefined()
      expect(requests[0]?.options.response_format).toBeUndefined()
      expect(requests[0]?.options.responseSchema).toBeUndefined()
      if (!(llm instanceof ChatBedrockConverse)) expect(requests[1]?.input).toContain(notes)
      if (provider === 'ollama') expect(requests[1]?.options.format).toMatchObject({ properties: { summary: { type: 'string' } } })
      if (provider === 'kimi') expect(requests[1]?.options.response_format).toMatchObject({ type: 'json_schema' })
      if (provider === 'google') expect(requests[1]?.options.responseSchema).toMatchObject({ properties: { summary: { type: 'string' } } })
    })

  it('Kimi keeps meaningful nulls while restoring strict-mode optional fields', async () => {
    const config = getConfig()
    const llm = getLLM({ ...config, llm: { ...config.llm, provider: 'kimi', kimiApiKey: 'test' } }, 'quick')
    const schema = z.object({ count: z.number(), details: z.object({
      requiredNullable: z.string().nullable(), optional: z.string().optional(), optionalNullable: z.string().nullable().optional(),
    }).nullable() })
    vi.spyOn(llm, 'invoke').mockResolvedValue(new AIMessageChunk({ content: JSON.stringify({ count: 0,
      details: { requiredNullable: null, optional: null, optionalNullable: null } }), response_metadata: { finish_reason: 'stop' } }))
    const result = await invokeStructured({ llm, schema, systemPrompt: 'Return the supplied record.', userMessage: 'Fixture', agentName: 'NullableContract' })
    expect(result).toEqual({ count: 0, details: { requiredNullable: null, optionalNullable: null } })
  })
  it.each(['ollama', 'kimi', 'google', 'cursor', 'bedrock'] as const)(
    '%s preserves debate applicability, uncertainty and exact candidate IDs', async provider => {
      const config = getConfig()
      const llm = getLLM({ ...config, llm: { ...config.llm, provider,
        googleApiKey: 'test', kimiApiKey: 'test', cursorApiKey: 'test' } }, 'quick')
      const schema = debateBatchSchema(['DRAFT-1', 'DRAFT-2'])
      const reply = { arguments: 'Source review', convergenceSignal: false, threatAssessments: [
        { draftId: 'DRAFT-1', threatDescription: 'Existing workflow', applicability: 'control_verification_needed', severity: null, notes: 'Reviewer accuracy has not been verified.' },
        { draftId: 'DRAFT-2', threatDescription: 'Absent component', applicability: 'out_of_scope', severity: null, notes: 'The source explicitly excludes this component.' },
      ] }
      const raw = new AIMessageChunk({ content: JSON.stringify(reply), response_metadata: { finish_reason: 'stop' } })
      let request = ''
      if (llm instanceof ChatBedrockConverse) {
        vi.spyOn(llm, 'withStructuredOutput').mockImplementation(received => {
          expect(received).toBe(schema)
          // Bedrock performs SDK validation before invokeStructured validates again.
          return { invoke: async () => ({ raw, parsed: schema.parse(reply) }) } as never
        })
      } else {
        vi.spyOn(llm, 'invoke').mockImplementation(async (input, options) => {
          request = JSON.stringify({ input, options })
          return raw
        })
      }
      const result = await invokeStructured({ llm, schema, systemPrompt: 'Assess applicability separately from severity.', userMessage: 'Original source', agentName: 'DebateContract' })
      expect(result.threatAssessments.map(normalizeDebateAssessment).map(item => item.verdict)).toEqual(['unresolved', 'invalid'])
      if (!(llm instanceof ChatBedrockConverse)) {
        expect(request).toContain('applicability')
        expect(request).toContain('DRAFT-2')
      }
    })
  it.each(['ollama', 'kimi', 'google', 'cursor', 'bedrock'] as const)(
    '%s preserves the full planning schema and validates the returned candidate set', async provider => {
      const config = getConfig()
      const llm = getLLM({ ...config, llm: { ...config.llm, provider,
        googleApiKey: 'test', kimiApiKey: 'test', cursorApiKey: 'test' } }, 'quick')
      const ids = Array.from({ length: 50 }, (_, i) => `C-${i + 1}`) as [string, ...string[]]
      const schema = synthesisPlanningSchema(ids, ['SRC-1'], 32_000)
      const reply = { candidates: Object.fromEntries(ids.map(id => [id, {
        decision: 'verify', mergeWith: [], sourceIds: ['SRC-1'], note: 'Control configuration unknown.',
      }])), deduplication: '', gaps: '', evidenceGap: '' }
      const raw = new AIMessageChunk({ content: JSON.stringify(reply), response_metadata: { finish_reason: 'stop' } })
      let options: Record<string, unknown> = {}
      let prompt = ''
      if (llm instanceof ChatBedrockConverse) {
        vi.spyOn(llm, 'withStructuredOutput').mockImplementation((receivedSchema) => {
          expect(receivedSchema).toBe(schema)
          return { invoke: async () => ({ raw, parsed: reply }) } as never
        })
      } else {
        vi.spyOn(llm, 'invoke').mockImplementation(async (input, callOptions) => {
          options = callOptions as Record<string, unknown>
          prompt = JSON.stringify(input)
          return raw
        })
      }
      const result = await invokeStructured({ llm, schema, systemPrompt: 'Build the candidate plan', userMessage: 'Original architecture', agentName: 'WorkflowContract' })
      expect(Object.keys(result.candidates)).toEqual(ids)
      const mechanism = selectStructuredMechanism(llm)
      if (mechanism === 'ollama-json-schema') expect(options.format).toMatchObject({ properties: { candidates: { required: ids } } })
      if (mechanism === 'openai-json-schema') expect(options.response_format).toMatchObject({ json_schema: { strict: true, schema: { properties: { candidates: { required: ids } } } } })
      if (mechanism === 'gemini-structured-output') expect(options.responseSchema).toMatchObject({ properties: { candidates: { required: ids } } })
      if (mechanism === 'prompt-fallback') expect(prompt).toContain('C-50')
    })

  it('rejects missing, duplicate and foreign validator IDs before applying enrichments', () => {
    const schema = validatorBatchSchema(['T1', 'T2'])
    const entry = { title: 'Scenario', description: 'Conditional impact', dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5 } }
    expect(schema.safeParse({ validations: [{ ...entry, id: 'T1' }, { ...entry, id: 'T2' }] }).success).toBe(true)
    for (const ids of [['T1'], ['T1', 'T1'], ['T1', 'foreign']]) {
      expect(schema.safeParse({ validations: ids.map(id => ({ ...entry, id })) }).success).toBe(false)
    }
  })
})
