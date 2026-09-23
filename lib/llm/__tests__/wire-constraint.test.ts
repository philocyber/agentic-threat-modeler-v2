import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import { z } from 'zod'
import { invokeStructured } from '@/lib/llm/structured'

/**
 * Provider schema enforcement is only real if it reaches the wire. A constraint
 * that is built but silently dropped costs the same money as no constraint at
 * all, and shows up much later as a phase that degrades on malformed output.
 * These tests capture the outgoing request body and assert the constraint is in
 * it, for every provider that takes one through call options.
 *
 * The schemas below are the exact shapes of the two agents that degraded on a
 * paid run: the judge (optional field + .extend()) and the DREAD validator
 * (.transform(), which has no JSON Schema representation).
 */
const Verdict = z.enum(['critical', 'high', 'medium', 'low', 'invalid'])
const Disposition = z.enum([
  'applicable',
  'conditional',
  'control_verification_needed',
  'mitigated',
  'invalid',
])
const Assessment = z.object({
  draftId: z.string(),
  threatDescription: z.string(),
  verdict: Verdict,
  disposition: Disposition.optional(),
  notes: z.string(),
})
const JudgeSchema = z.object({
  summary: z.string(),
  convergenceSignal: z.boolean(),
  threatAssessments: z.array(Assessment.extend({ finalVerdict: Verdict })),
})
const ValidatorSchema = z.object({
  validations: z.array(
    z.object({
      id: z.string(),
      correctionReason: z.string().transform((value) => value.slice(0, 200)).optional(),
    }),
  ),
})

const servers: Server[] = []

/** Fake provider that records every request body it receives. */
async function capturingServer(responseBody: (path: string) => unknown) {
  const bodies: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(responseBody(req.url ?? '')))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  servers.push(server)
  const { port } = server.address() as { port: number }
  return { bodies, port }
}

const JUDGE_REPLY = '{"summary":"s","convergenceSignal":true,"threatAssessments":[]}'
const VALIDATOR_REPLY = '{"validations":[]}'

function openAIReply(content: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'kimi-k2.6',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }
}

afterAll(() => {
  for (const server of servers) server.close()
})

describe('the provider constraint reaches the wire', () => {
  it('sends response_format for an OpenAI-compatible provider (Kimi/Moonshot)', async () => {
    const { bodies, port } = await capturingServer(() => openAIReply(JUDGE_REPLY))
    const llm = new ChatOpenAI({
      apiKey: 'test',
      model: 'kimi-k2.6',
      maxRetries: 0,
      configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
    })

    await invokeStructured({
      llm,
      schema: JudgeSchema,
      systemPrompt: 'sys',
      userMessage: 'user',
      agentName: 'DebateJudge',
      timeoutMs: 20_000,
    })

    expect(bodies).toHaveLength(1)
    const sent = bodies[0] as { response_format?: { type?: string; json_schema?: { schema?: unknown } } }
    expect(sent.response_format?.type).toBe('json_schema')
    // The schema itself must travel, not just the wrapper.
    expect(sent.response_format?.json_schema?.schema).toMatchObject({
      properties: { threatAssessments: expect.anything() },
    })

    // Measured against kimi-k2.6: the same schema carrying `$schema` came back
    // as 7 tokens of garbage, while stripping it returned all 25 assessments.
    // Nothing may reintroduce that key, at any depth.
    expect(JSON.stringify(sent.response_format?.json_schema?.schema)).not.toContain('$schema')
  })

  it('normalizes the schema to the strict contract OpenAI requires', async () => {
    const { bodies, port } = await capturingServer(() => openAIReply(JUDGE_REPLY))
    const llm = new ChatOpenAI({
      apiKey: 'test',
      model: 'kimi-k2.6',
      maxRetries: 0,
      configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
    })

    await invokeStructured({
      llm,
      schema: JudgeSchema,
      systemPrompt: 'sys',
      userMessage: 'user',
      agentName: 'DebateJudge',
      timeoutMs: 20_000,
    })

    const sent = bodies[0] as {
      response_format?: { json_schema?: { strict?: boolean; schema?: Record<string, unknown> } }
    }
    const schema = sent.response_format?.json_schema?.schema as {
      additionalProperties?: boolean
      required?: string[]
      properties: { threatAssessments: { items: { required?: string[]; properties: Record<string, unknown> } } }
    }
    expect(sent.response_format?.json_schema?.strict).toBe(true)
    expect(schema.additionalProperties).toBe(false)

    // Strict mode requires every property in `required`, at every level —
    // `disposition` is optional in Zod and must still be listed here.
    const item = schema.properties.threatAssessments.items
    expect(item.required).toEqual(expect.arrayContaining(['disposition', 'finalVerdict']))
    // …and optionality is preserved by letting it be null instead.
    expect(item.properties.disposition).toMatchObject({
      anyOf: expect.arrayContaining([{ type: 'null' }]),
    })
  })

  it('accepts a response whose optional fields came back null', async () => {
    const withNulls = JSON.stringify({
      summary: 's',
      convergenceSignal: true,
      threatAssessments: [
        {
          draftId: 'DRAFT-1',
          threatDescription: 'd',
          verdict: 'high',
          disposition: null,
          notes: 'n',
          finalVerdict: 'high',
        },
      ],
    })
    const { port } = await capturingServer(() => openAIReply(withNulls))
    const llm = new ChatOpenAI({
      apiKey: 'test',
      model: 'kimi-k2.6',
      maxRetries: 0,
      configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
    })

    const out = await invokeStructured({
      llm,
      schema: JudgeSchema,
      systemPrompt: 'sys',
      userMessage: 'user',
      agentName: 'DebateJudge',
      timeoutMs: 20_000,
    })

    // `disposition` is .optional(), not .nullable(): the null the strict schema
    // invited must be gone before Zod runs, or the phase degrades on a valid answer.
    expect(out.threatAssessments[0]?.disposition).toBeUndefined()
    expect(out.threatAssessments[0]?.finalVerdict).toBe('high')
  })

  it('sends the native format for Ollama', async () => {
    const { bodies, port } = await capturingServer(() => ({
      model: 'qwen3.5',
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: JUDGE_REPLY },
      done: true,
      done_reason: 'stop',
    }))
    const llm = new ChatOllama({ model: 'qwen3.5', baseUrl: `http://127.0.0.1:${port}` })

    await invokeStructured({
      llm,
      schema: JudgeSchema,
      systemPrompt: 'sys',
      userMessage: 'user',
      agentName: 'DebateJudge',
      timeoutMs: 20_000,
    })

    const sent = bodies[0] as { format?: { properties?: Record<string, unknown> } }
    expect(sent.format?.properties).toHaveProperty('threatAssessments')
    // Ollama compiles this into a grammar; meta keywords have no place in it.
    expect(JSON.stringify(sent.format)).not.toContain('$schema')
  })

  it('still constrains a schema carrying .transform() (DREAD validator)', async () => {
    const { bodies, port } = await capturingServer(() => openAIReply(VALIDATOR_REPLY))
    const llm = new ChatOpenAI({
      apiKey: 'test',
      model: 'kimi-k2.6',
      maxRetries: 0,
      configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
    })

    await invokeStructured({
      llm,
      schema: ValidatorSchema,
      systemPrompt: 'sys',
      userMessage: 'user',
      agentName: 'DreadValidator',
      timeoutMs: 20_000,
    })

    const sent = bodies[0] as { response_format?: { json_schema?: { schema?: unknown } } }
    expect(sent.response_format?.json_schema?.schema).toMatchObject({
      properties: { validations: expect.anything() },
    })
  })
})
