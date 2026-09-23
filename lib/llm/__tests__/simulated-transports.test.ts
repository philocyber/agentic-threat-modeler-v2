import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIMessageChunk } from '@langchain/core/messages'
import { z } from 'zod'
import { ChatBedrockConverse } from '@langchain/aws'
import { getConfig } from '@/lib/config'
import { getLLM, clearLLMCache } from '../factory'
import { invokeStructured, selectStructuredMechanism } from '../structured'
import { StructuredOutputError } from '../structured'
import { invokeStructuredWithRetry } from '@/lib/agents/base'
import { getBestEffortParseCount, resetBestEffortParseCount } from '@/lib/agents/base'

afterEach(() => {
  clearLLMCache()
  vi.restoreAllMocks()
  resetBestEffortParseCount()
})

const schema = z.object({
  threats: z.array(z.object({
    component: z.string(),
    passageId: z.string(),
    excerpt: z.string().optional(),
  })),
})

describe('simulated provider transports', () => {
  it.each(['ollama', 'kimi', 'google', 'cursor', 'bedrock'] as const)(
    '%s sends one constrained emission path and classifies incomplete JSON', async (provider) => {
      const config = getConfig()
      const llm = getLLM({
        ...config,
        llm: { ...config.llm, provider, googleApiKey: 'test', kimiApiKey: 'test', cursorApiKey: 'test' },
      }, 'quick')
      if (provider === 'cursor') expect(selectStructuredMechanism(llm)).toBe('prompt-fallback')
      if (provider === 'kimi') {
        vi.spyOn(llm, 'invoke').mockResolvedValue(new AIMessageChunk({
          content: '{"threats":[{"component":"API"',
          response_metadata: { finish_reason: 'stop' },
        }))
      } else if (llm instanceof ChatBedrockConverse) {
        vi.spyOn(llm, 'withStructuredOutput').mockReturnValue({
          invoke: async () => ({ raw: new AIMessageChunk({ content: '{"threats":[' }), parsingError: new Error('truncated object') }),
        } as never)
      } else {
        vi.spyOn(llm, 'invoke').mockResolvedValue(new AIMessageChunk({
          content: '{"threats":[{"component":"API"',
          response_metadata: { finish_reason: 'stop' },
        }))
      }
      const error = await invokeStructured({
        llm, schema, systemPrompt: 'Return threats.', userMessage: 'Fixture', agentName: `${provider}Incomplete`,
      }).catch((err) => err)
      expect(error).toBeInstanceOf(StructuredOutputError)
      expect(getBestEffortParseCount()).toBe(0)
    })

  it('does not add a hidden free-text fallback after structured failure', async () => {
    const config = getConfig()
    const llm = getLLM({ ...config, llm: { ...config.llm, provider: 'ollama' } }, 'quick')
    let calls = 0
    vi.spyOn(llm, 'invoke').mockImplementation(async () => {
      calls += 1
      return new AIMessageChunk({ content: '{"threats":"nope"}', response_metadata: { finish_reason: 'stop' } })
    })
    await expect(invokeStructuredWithRetry({
      llm, schema, systemPrompt: 'Return threats.', userMessage: 'Fixture', agentName: 'NoFallback', maxRetries: 2,
    })).rejects.toBeInstanceOf(StructuredOutputError)
    expect(calls).toBe(2)
    expect(getBestEffortParseCount()).toBe(0)
  })

  it('Kimi json_schema contract includes name, schema and strict', async () => {
    const config = getConfig()
    const llm = getLLM({ ...config, llm: { ...config.llm, provider: 'kimi', kimiApiKey: 'test' } }, 'quick')
    let request: Record<string, unknown> | undefined
    vi.spyOn(llm, 'invoke').mockImplementation(async (_input, options) => {
      request = options as Record<string, unknown>
      return new AIMessageChunk({
        content: JSON.stringify({ threats: [{ component: 'API', passageId: 'SRC-0001' }] }),
        response_metadata: { finish_reason: 'stop' },
      })
    })
    await invokeStructured({ llm, schema, systemPrompt: 'Return threats.', userMessage: 'Fixture', agentName: 'KimiSchema' })
    expect(request?.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'KimiSchema_output', strict: true },
    })
    expect((request?.response_format as { json_schema?: { schema?: unknown } } | undefined)?.json_schema?.schema).toBeTruthy()
  })

  it('classifies cancellation without treating it as a schema repair', async () => {
    const config = getConfig()
    const llm = getLLM({ ...config, llm: { ...config.llm, provider: 'ollama' } }, 'quick')
    const abort = new AbortController()
    abort.abort()
    const error = await invokeStructured({
      llm, schema, systemPrompt: 'Return threats.', userMessage: 'Fixture', agentName: 'Cancelled', signal: abort.signal,
    }).catch((err) => err)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('AbortError')
  })
})
