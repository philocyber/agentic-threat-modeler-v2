import { afterEach, describe, it, expect } from 'vitest'
import { ChatOllama } from '@langchain/ollama'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { ChatOpenAI } from '@langchain/openai'
import { ChatBedrockConverse } from '@langchain/aws'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { z } from 'zod'
import {
  DEFAULT_STRUCTURED_TIMEOUT_MS,
  StructuredOutputError,
  StructuredOutputTimeoutError,
  StructuredOutputTruncatedError,
  invokeStructured,
  selectStructuredMechanism,
} from '@/lib/llm/structured'
import { _clearStructuredResponseCache } from '@/lib/llm/response-cache'
import { emptyUsage, runWithUsage } from '@/lib/llm/usage'

afterEach(() => {
  delete process.env.LLM_RESPONSE_CACHE_ENABLED
  delete process.env.LLM_RESPONSE_CACHE_MAX_ENTRIES
  delete process.env.LLM_RESPONSE_CACHE_TTL_MS
  _clearStructuredResponseCache()
})

const ThreatSchema = z.object({
  threats: z.array(
    z.object({
      title: z.string(),
      severity: z.enum(['low', 'medium', 'high']),
    })
  ),
})
type Threats = z.infer<typeof ThreatSchema>

const VALID: Threats = { threats: [{ title: 'Spoofing the agent', severity: 'high' }] }

/** Provider message that completed normally, as returned alongside includeRaw. */
function rawMessage(finishReason = 'stop'): { response_metadata: Record<string, unknown> } {
  return { response_metadata: { finish_reason: finishReason } }
}

/** Minimal fake chat model: only what the prompt-fallback path touches. */
function fakeLLM(invoke: (messages: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>): {
  model: BaseChatModel
  state: { calls: number }
} {
  const state = { calls: 0 }
  const model = {
    invoke: (messages: unknown, options?: { signal?: AbortSignal }) => {
      state.calls++
      return invoke(messages, options)
    },
  } as unknown as BaseChatModel
  return { model, state }
}

function textResponse(text: string) {
  return { content: text }
}


/** Stubs the model's invoke and captures the call options the lib passes. */
function stubInvoke(llm: unknown, response: unknown): () => Record<string, unknown> {
  let captured: Record<string, unknown> = {}
  ;(llm as { invoke: unknown }).invoke = async (_messages: unknown, options: Record<string, unknown>) => {
    captured = options ?? {}
    return response
  }
  return () => captured
}

function okMessage(value: unknown, metadata: Record<string, unknown> = { finish_reason: 'stop' }) {
  return { content: JSON.stringify(value), response_metadata: metadata }
}

const baseParams = {
  schema: ThreatSchema,
  systemPrompt: 'You are a threat analyst.',
  userMessage: 'Analyze this architecture.',
  agentName: 'test-agent',
}

describe('selectStructuredMechanism', () => {
  it('picks the native mechanism per provider class', () => {
    expect(selectStructuredMechanism(new ChatOllama({ model: 'qwen3:4b' }))).toBe(
      'ollama-json-schema'
    )
    expect(
      selectStructuredMechanism(
        new ChatGoogleGenerativeAI({ apiKey: 'test', model: 'gemini-2.0-flash' })
      )
    ).toBe('gemini-structured-output')
    expect(
      selectStructuredMechanism(new ChatOpenAI({ apiKey: 'test', model: 'kimi-k3' }))
    ).toBe('openai-json-schema')
    expect(
      selectStructuredMechanism(
        new ChatBedrockConverse({
          model: 'anthropic.claude-3-5-haiku-20241022-v1:0',
          region: 'us-east-1',
          credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
        })
      )
    ).toBe('bedrock-tool-use')
  })

  it('falls back to prompt-fallback for unknown models', () => {
    const { model } = fakeLLM(async () => textResponse('{}'))
    expect(selectStructuredMechanism(model)).toBe('prompt-fallback')
  })
})

describe('invokeStructured — prompt-fallback path', () => {
  it('returns parsed data for valid JSON output', async () => {
    const { model } = fakeLLM(async () => textResponse(JSON.stringify(VALID)))
    const out = await invokeStructured<Threats>({ ...baseParams, llm: model })
    expect(out).toEqual(VALID)
  })

  it('extracts JSON from markdown fences and prose', async () => {
    const { model } = fakeLLM(async () =>
      textResponse(`Here you go:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\nDone.`)
    )
    const out = await invokeStructured<Threats>({ ...baseParams, llm: model })
    expect(out).toEqual(VALID)
  })

  it('repairs literal control characters inside JSON strings before validation', async () => {
    const title = 'Spoofing\tthe agent\nthrough a quoted source line'
    const raw = `{"threats":[{"title":"${title}","severity":"high"}]}`
    const { model } = fakeLLM(async () => textResponse(raw))
    const out = await invokeStructured<Threats>({ ...baseParams, llm: model })
    expect(out).toEqual({ threats: [{ title, severity: 'high' }] })
  })

  it('throws StructuredOutputError with Zod issues on schema mismatch', async () => {
    const bad = { threats: [{ title: 42, severity: 'extreme' }] }
    const { model } = fakeLLM(async () => textResponse(JSON.stringify(bad)))

    const err = await invokeStructured<Threats>({ ...baseParams, llm: model }).catch((e) => e)
    expect(err).toBeInstanceOf(StructuredOutputError)
    const soe = err as StructuredOutputError
    expect(soe.name).toBe('StructuredOutputError')
    expect(soe.agentName).toBe('test-agent')
    expect(soe.mechanism).toBe('prompt-fallback')
    expect(soe.issues.length).toBeGreaterThan(0)
    // Issues carry path + message so a retry loop can feed them back into the prompt.
    expect(soe.issues.map((i) => i.path.join('.'))).toContain('threats.0.title')
    expect(soe.rawOutput).toContain('extreme')
  })

  it('throws StructuredOutputError (no issues) when output is not JSON at all', async () => {
    const { model } = fakeLLM(async () => textResponse('I cannot help with that.'))
    const err = await invokeStructured<Threats>({ ...baseParams, llm: model }).catch((e) => e)
    expect(err).toBeInstanceOf(StructuredOutputError)
    expect((err as StructuredOutputError).issues).toEqual([])
    expect((err as StructuredOutputError).rawOutput).toContain('cannot help')
  })
})

describe('invokeStructured — opt-in response cache', () => {
  it('reuses only a successful schema-validated response', async () => {
    process.env.LLM_RESPONSE_CACHE_ENABLED = 'yes'
    const { model, state } = fakeLLM(async () => textResponse(JSON.stringify(VALID)))
    await invokeStructured<Threats>({ ...baseParams, llm: model })
    await invokeStructured<Threats>({ ...baseParams, llm: model })
    expect(state.calls).toBe(1)
  })

  it('does not cache errors', async () => {
    process.env.LLM_RESPONSE_CACHE_ENABLED = 'true'
    const { model, state } = fakeLLM(async () => textResponse('not json'))
    await expect(invokeStructured<Threats>({ ...baseParams, llm: model })).rejects.toBeInstanceOf(StructuredOutputError)
    await expect(invokeStructured<Threats>({ ...baseParams, llm: model })).rejects.toBeInstanceOf(StructuredOutputError)
    expect(state.calls).toBe(2)
  })
})

describe('invokeStructured — provider/model/agent usage attribution', () => {
  it.each([
    ['ollama', () => new ChatOllama({ model: 'qwen-test' })],
    ['kimi', () => new ChatOpenAI({ apiKey: 'test', model: 'kimi-test' })],
    ['google', () => new ChatGoogleGenerativeAI({ apiKey: 'test', model: 'gemini-test' })],
  ] as const)('records normalized usage for %s', async (provider, createModel) => {
    const llm = createModel()
    stubInvoke(llm, {
      ...okMessage(VALID, { finish_reason: 'stop' }),
      usage_metadata: { input_tokens: 13, output_tokens: 5, total_tokens: 18 },
    })
    const usage = emptyUsage()
    await runWithUsage(usage, () => invokeStructured<Threats>({ ...baseParams, llm }))
    expect(usage.calls).toBe(1)
    expect(Object.keys(usage.byProviderModelAgent)[0]).toMatch(new RegExp(`^${provider}:.*:test-agent$`))
  })

  it('records normalized Bedrock tool-use usage', async () => {
    const llm = new ChatBedrockConverse({
      model: 'anthropic.test-v1:0',
      region: 'us-east-1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    })
    llm.withStructuredOutput = (() => ({
      invoke: async () => ({
        raw: { usage_metadata: { input_tokens: 17, output_tokens: 9, total_tokens: 26 } },
        parsed: VALID,
      }),
    })) as unknown as typeof llm.withStructuredOutput
    const usage = emptyUsage()
    await runWithUsage(usage, () => invokeStructured<Threats>({ ...baseParams, llm }))
    expect(usage.byProviderModelAgent['bedrock:anthropic.test-v1:0:test-agent'])
      .toMatchObject({ inputTokens: 17, outputTokens: 9, calls: 1 })
  })
})

describe('invokeStructured — native mechanism wiring (no network)', () => {
  it('passes the JSON schema as Ollama native format', async () => {
    const llm = new ChatOllama({ model: 'qwen3:4b' })
    const captured = stubInvoke(llm, okMessage(VALID))

    const out = await invokeStructured<Threats>({ ...baseParams, llm })
    expect(out).toEqual(VALID)
    expect(captured().format).toMatchObject({ type: 'object' })
  })

  it('requests json_schema + strict for OpenAI-compatible (Kimi)', async () => {
    const llm = new ChatOpenAI({ apiKey: 'test', model: 'kimi-k3' })
    const captured = stubInvoke(llm, okMessage(VALID))

    await invokeStructured<Threats>({ ...baseParams, llm })
    expect(captured().response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'test-agent_output', strict: true },
    })
  })

  it('uses tool-use (no response_format) for Bedrock Converse', async () => {
    const llm = new ChatBedrockConverse({
      model: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      region: 'us-east-1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    })
    let captured: unknown
    llm.withStructuredOutput = ((_schema: unknown, config: unknown) => {
      captured = config
      return { invoke: async () => ({ raw: rawMessage(), parsed: VALID }) }
    }) as unknown as typeof llm.withStructuredOutput

    await invokeStructured<Threats>({ ...baseParams, llm })
    expect(captured).toMatchObject({ name: 'test-agent_output', includeRaw: true })
  })

  it('rejects with StructuredOutputError when the model returns invalid data', async () => {
    const llm = new ChatOllama({ model: 'qwen3:4b' })
    stubInvoke(llm, okMessage({ threats: [{ title: 'x', severity: 'bogus' }] }))

    const err = await invokeStructured<Threats>({ ...baseParams, llm }).catch((e) => e)
    expect(err).toBeInstanceOf(StructuredOutputError)
    expect((err as StructuredOutputError).mechanism).toBe('ollama-json-schema')
    expect((err as StructuredOutputError).issues.length).toBeGreaterThan(0)
  })
})

describe('invokeStructured — parse failures stay classifiable', () => {
  // Bedrock keeps the SDK envelope, which reports the failure instead of
  // throwing. Unnormalized it classifies as `unknown`, and the retry loop only
  // feeds Zod issues back into the prompt for `validation`.
  function bedrock(): ChatBedrockConverse {
    return new ChatBedrockConverse({
      model: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      region: 'us-east-1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    })
  }

  const parseFailures: Array<{ label: string; error: unknown }> = [
    { label: 'an error carrying .issues', error: Object.assign(new Error('parse failed'), {
        issues: [{ code: 'invalid_type', expected: 'object', path: [], message: 'expected object, received array' }],
      }) },
    { label: 'an error whose message is the serialized issue array', error: new Error(
        JSON.stringify([{ expected: 'object', code: 'invalid_type', path: [], message: 'Invalid input: expected object, received array' }]),
      ) },
  ]

  for (const { label, error } of parseFailures) {
    it(`reports ${label} as a StructuredOutputError with issues`, async () => {
      const llm = bedrock()
      llm.withStructuredOutput = (() => ({
        invoke: async () => ({ raw: rawMessage(), parsed: undefined, parsingError: error }),
      })) as unknown as typeof llm.withStructuredOutput

      const err = await invokeStructured<Threats>({ ...baseParams, llm }).catch((e) => e)
      expect(err).toBeInstanceOf(StructuredOutputError)
      expect((err as StructuredOutputError).issues.length).toBeGreaterThan(0)
    })
  }

  it('repairs a mis-wrapped payload from the envelope instead of failing', async () => {
    const llm = bedrock()
    llm.withStructuredOutput = (() => ({
      invoke: async () => ({
        raw: { content: JSON.stringify(VALID.threats), response_metadata: { stopReason: 'end_turn' } },
        parsed: undefined,
        parsingError: new Error('expected object, received array'),
      }),
    })) as unknown as typeof llm.withStructuredOutput

    await expect(invokeStructured<Threats>({ ...baseParams, llm })).resolves.toEqual(VALID)
  })
})

describe('invokeStructured — truncation is provider-agnostic', () => {
  // Each provider reports the same condition under a different key. Missing any
  // of them sends the caller into an identical, equally doomed retry.
  const cases: Array<{ label: string; metadata: Record<string, unknown> }> = [
    { label: 'OpenAI-compatible (Kimi)', metadata: { finish_reason: 'length' } },
    { label: 'Gemini', metadata: { finishReason: 'MAX_TOKENS' } },
    { label: 'Ollama', metadata: { done_reason: 'length' } },
  ]

  for (const { label, metadata } of cases) {
    it(`flags a cut response as truncated for ${label}`, async () => {
      const llm = new ChatOllama({ model: 'qwen3:4b' })
      stubInvoke(llm, {
        content: '{"threats":[{"title":"cut off",',
        response_metadata: metadata,
        usage_metadata: { output_tokens: 16384 },
      })

      const err = await invokeStructured<Threats>({ ...baseParams, llm }).catch((e) => e)
      expect(err).toBeInstanceOf(StructuredOutputTruncatedError)
      expect((err as StructuredOutputTruncatedError).outputTokens).toBe(16384)
    })
  }

  it('flags a cut response as truncated for Bedrock Converse', async () => {
    const llm = new ChatBedrockConverse({
      model: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      region: 'us-east-1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    })
    llm.withStructuredOutput = (() => ({
      invoke: async () => ({
        raw: { response_metadata: { stopReason: 'max_tokens' }, usage_metadata: { output_tokens: 4096 } },
        parsed: undefined,
        parsingError: new Error('unexpected end of JSON input'),
      }),
    })) as unknown as typeof llm.withStructuredOutput

    const err = await invokeStructured<Threats>({ ...baseParams, llm }).catch((e) => e)
    expect(err).toBeInstanceOf(StructuredOutputTruncatedError)
  })

  it('does not flag a normal completion as truncated', async () => {
    const llm = new ChatOllama({ model: 'qwen3:4b' })
    stubInvoke(llm, okMessage(VALID))
    await expect(invokeStructured<Threats>({ ...baseParams, llm })).resolves.toEqual(VALID)
  })

  it('detects truncation on the prompt-fallback path too', async () => {
    const { model } = fakeLLM(async () => ({
      content: '{"threats":[{"title":"cut off",',
      response_metadata: { finish_reason: 'length' },
    }))

    const err = await invokeStructured<Threats>({ ...baseParams, llm: model }).catch((e) => e)
    expect(err).toBeInstanceOf(StructuredOutputTruncatedError)
  })
})

describe('invokeStructured — timeout and abort', () => {
  it('keeps the remote-provider default at 120s', () => {
    expect(DEFAULT_STRUCTURED_TIMEOUT_MS).toBe(120_000)
  })

  it('times out even if the model never responds', async () => {
    const { model } = fakeLLM(() => new Promise(() => {}))
    const err = await invokeStructured<Threats>({
      ...baseParams,
      llm: model,
      timeoutMs: 50,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(StructuredOutputTimeoutError)
    expect((err as Error).name).toBe('TimeoutError')
    expect((err as StructuredOutputTimeoutError).timeoutMs).toBe(50)
  })

  it('rejects immediately on a pre-aborted external signal without calling the model', async () => {
    const { model, state } = fakeLLM(async () => textResponse(JSON.stringify(VALID)))
    const controller = new AbortController()
    controller.abort()
    const err = await invokeStructured<Threats>({
      ...baseParams,
      llm: model,
      signal: controller.signal,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('AbortError')
    expect(state.calls).toBe(0)
  })

  it('external abort wins over a long timeout while the call is in flight', async () => {
    const { model } = fakeLLM(() => new Promise(() => {}))
    const controller = new AbortController()
    const promise = invokeStructured<Threats>({
      ...baseParams,
      llm: model,
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 20)
    const err = await promise.catch((e) => e)
    expect((err as Error).name).toBe('AbortError')
  })
})
