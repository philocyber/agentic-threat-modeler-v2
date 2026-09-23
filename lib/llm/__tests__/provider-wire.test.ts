import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ChatBedrockConverse } from '@langchain/aws'
import { getConfig } from '@/lib/config'
import { getLLM, clearLLMCache } from '../factory'
import { invokeStructured } from '../structured'
import { setCursorPromptImpl } from '../cursor'
import { emptyUsage, runWithUsage } from '../usage'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearLLMCache(); setCursorPromptImpl(undefined) })

const schema = z.object({ ok: z.boolean(), note: z.string().optional() })
const request = { schema, systemPrompt: 'Return a status object.', userMessage: 'Synthetic fixture only.', agentName: 'WireFixture' }
const googleResponse = {
  candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
}

describe('provider SDK wire contracts (no external requests)', () => {
  it('serializes Kimi native schema and output limit into the HTTP body', async () => {
    let body: Record<string, unknown> = {}
    const fetch = vi.fn(async (_url, init) => {
      body = JSON.parse(String(init.body))
      return Response.json({
        id: 'fixture', object: 'chat.completion', created: 0, model: 'kimi-k2.6',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true,"note":null}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    })
    vi.stubGlobal('fetch', fetch)
    const config = getConfig()
    const llm = getLLM({ ...config, llm: { ...config.llm, provider: 'kimi', kimiApiKey: 'synthetic', kimiQuickMaxTokens: 1234 } }, 'quick', false, 'kimi-k2.6')
    const usage = emptyUsage()
    expect(await runWithUsage(usage, () => invokeStructured({ ...request, llm }))).toEqual({ ok: true })
    expect(body).toMatchObject({ model: 'kimi-k2.6', max_completion_tokens: 1234, response_format: { type: 'json_schema', json_schema: { name: 'WireFixture_output', strict: true } } })
    expect(body).not.toHaveProperty('max_tokens')
    expect(fetch).toHaveBeenCalledOnce()
    expect(usage.calls).toBe(1)
  })

  it('serializes Gemini generationConfig and records actual response usage', async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const req = new Request(input, init)
      body = JSON.parse(await req.text())
      return Response.json(googleResponse)
    }))
    const config = getConfig()
    const llm = getLLM({ ...config, llm: { ...config.llm, provider: 'google', googleApiKey: 'synthetic', geminiQuickMaxTokens: 1234 } }, 'quick', false, 'gemini-2.0-flash')
    const usage = emptyUsage()
    expect(await runWithUsage(usage, () => invokeStructured({ ...request, llm }))).toEqual({ ok: true })
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 1234, responseMimeType: 'application/json', responseSchema: { type: 'object' } } })
    expect(usage).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5 })
  })

  it('propagates cancellation through Gemini to the HTTP request', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let transportSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      transportSignal = new Request(input, init).signal
      started.resolve()
      await release.promise
      transportSignal.throwIfAborted()
      return Response.json(googleResponse)
    }))
    const config = getConfig()
    const llm = getLLM({ ...config, llm: { ...config.llm, provider: 'google', googleApiKey: 'synthetic' } }, 'quick')
    const controller = new AbortController()
    const result = llm.invoke('Synthetic fixture', { signal: controller.signal }).catch(error => error)
    try {
      await started.promise
      controller.abort()
      expect(transportSignal?.aborted).toBe(true)
    } finally { release.resolve(); await result }
  })

  it('serializes Bedrock forced tool use through the AWS HTTP serializer', async () => {
    const llm = new ChatBedrockConverse({
      model: 'anthropic.claude-3-5-haiku-20241022-v1:0', region: 'us-east-1', maxTokens: 1234,
      credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, clientOptions: { maxAttempts: 1 },
    })
    let body: Record<string, unknown> = {}
    vi.spyOn(llm.client.config.requestHandler, 'handle').mockImplementation(async (req) => {
      body = JSON.parse(String(req.body))
      return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({
        output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'fixture', name: 'WireFixture_output', input: { ok: true } } }] } },
        stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 },
      })) } }
    })
    expect(await invokeStructured({ ...request, llm })).toEqual({ ok: true })
    expect(body).toMatchObject({ inferenceConfig: { maxTokens: 1234 }, toolConfig: { toolChoice: { tool: { name: 'WireFixture_output' } } } })
  })

  it('passes the structured contract to the Cursor SDK without tools or workspace access', async () => {
    const prompt = vi.fn(async () => ({ id: 'synthetic', status: 'finished' as const, result: '{"ok":true}' }))
    setCursorPromptImpl(prompt)
    const config = getConfig()
    const llm = getLLM({ ...config, llm: { ...config.llm, provider: 'cursor', cursorApiKey: 'synthetic' } }, 'quick')
    expect(await invokeStructured({ ...request, llm })).toEqual({ ok: true })
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('JSON Schema'), expect.objectContaining({ tools: [], local: expect.objectContaining({ settingSources: [] }) }))
  })
})
