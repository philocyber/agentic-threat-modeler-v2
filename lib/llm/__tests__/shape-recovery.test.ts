import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'
import { invokeStructured, selectStructuredMechanism } from '@/lib/llm/structured'

/**
 * Reproduces the failure that cost two paid Kimi runs: DebateJudge and
 * DreadValidator answered with a bare array where the schema expects the
 * wrapper object, and every attempt re-requested the same content — minutes and
 * tokens per retry. The payload was always usable, so it must be recovered on
 * the first response.
 *
 * The fake endpoint speaks the OpenAI chat-completions shape that Moonshot
 * implements, so the assertion runs through the real @langchain/openai adapter
 * instead of a hand-rolled mock.
 */
const JudgeSchema = z.object({
  threatAssessments: z.array(z.object({ draftId: z.string(), finalVerdict: z.string() })),
})

const servers: Server[] = []

async function fakeProvider(content: string): Promise<ChatOpenAI> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'kimi-k2.6',
          choices: [
            { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  servers.push(server)
  const { port } = server.address() as { port: number }
  return new ChatOpenAI({
    apiKey: 'test',
    model: 'kimi-k2.6',
    maxRetries: 0,
    configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
  })
}

afterAll(() => {
  for (const server of servers) server.close()
})

const ASSESSMENTS = [
  { draftId: 'DRAFT-1', finalVerdict: 'high' },
  { draftId: 'DRAFT-2', finalVerdict: 'medium' },
]

describe('invokeStructured — recovers a mis-wrapped payload without another call', () => {
  it('takes the OpenAI-compatible native mechanism for a Kimi-style model', async () => {
    const llm = await fakeProvider(JSON.stringify({ threatAssessments: ASSESSMENTS }))
    expect(selectStructuredMechanism(llm)).toBe('openai-json-schema')
  })

  it('accepts the wrapper object (baseline)', async () => {
    const llm = await fakeProvider(JSON.stringify({ threatAssessments: ASSESSMENTS }))
    const out = await invokeStructured({
      llm,
      schema: JudgeSchema,
      systemPrompt: 'sys',
      userMessage: 'user',
      agentName: 'DebateJudge',
      timeoutMs: 20_000,
    })
    expect(out.threatAssessments).toHaveLength(2)
  })

  it('recovers when the model answers with the bare array', async () => {
    const llm = await fakeProvider(JSON.stringify(ASSESSMENTS))
    const out = await invokeStructured({
      llm,
      schema: JudgeSchema,
      systemPrompt: 'sys',
      userMessage: 'user',
      agentName: 'DebateJudge',
      timeoutMs: 20_000,
    })
    // The exact case that degraded two paid runs.
    expect(out.threatAssessments).toEqual(ASSESSMENTS)
  })

  it('recovers when the model answers with a single bare object', async () => {
    const llm = await fakeProvider(JSON.stringify(ASSESSMENTS[0]))
    const out = await invokeStructured({
      llm,
      schema: JudgeSchema,
      systemPrompt: 'sys',
      userMessage: 'user',
      agentName: 'DreadValidator',
      timeoutMs: 20_000,
    })
    expect(out.threatAssessments).toEqual([ASSESSMENTS[0]])
  })
})

describe('invokeStructured — schemas the provider cannot enforce', () => {
  // The synthesizer and the validator trim fields with .transform(), which has
  // no JSON Schema representation. Converting it threw before any request left
  // the process: three instant "failures" per phase and a degraded run.
  const TransformSchema = z.object({
    threats: z.array(
      z.object({
        title: z.string(),
        description: z.string().transform((value) => value.slice(0, 10)),
      }),
    ),
  })

  it('still produces a result instead of failing on conversion', async () => {
    const payload = { threats: [{ title: 'Spoofing', description: 'a very long description' }] }
    const llm = await fakeProvider(JSON.stringify(payload))

    const out = await invokeStructured({
      llm,
      schema: TransformSchema,
      systemPrompt: 'sys',
      userMessage: 'user',
      agentName: 'ThreatSynthesizer',
      timeoutMs: 20_000,
    })

    // The transform still runs on the response.
    expect(out.threats[0]?.description).toBe('a very lon')
  })
})

