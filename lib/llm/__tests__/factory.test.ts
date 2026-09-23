import { describe, it, expect, afterEach, vi } from 'vitest'
import { ChatOllama } from '@langchain/ollama'
import { ChatOpenAI } from '@langchain/openai'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { getLLM, clearLLMCache } from '@/lib/llm/factory'
import { getConfig, clearConfigCache, type AppConfig } from '@/lib/config'

function ollamaConfig(overrides: Partial<AppConfig['llm']> = {}): AppConfig {
  const base = getConfig()
  return { ...base, llm: { ...base.llm, provider: 'ollama', ...overrides } }
}

function providerConfig(
  provider: AppConfig['llm']['provider'],
  overrides: Partial<AppConfig['llm']> = {},
): AppConfig {
  const base = getConfig()
  return { ...base, llm: { ...base.llm, provider, ...overrides } }
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearLLMCache()
})

describe('LLM factory — Ollama jsonMode', () => {
  it('enables native JSON mode when jsonMode=true', () => {
    const llm = getLLM(ollamaConfig(), 'quick', true)
    expect(llm).toBeInstanceOf(ChatOllama)
    expect((llm as ChatOllama).format).toBe('json')
  })

  it('leaves format unset when jsonMode=false', () => {
    const llm = getLLM(ollamaConfig(), 'quick', false)
    expect((llm as ChatOllama).format).toBeUndefined()
  })
})

describe('LLM factory — Ollama numCtx', () => {
  it('uses the raised defaults (quick 16384 / deep 32768)', () => {
    const quick = getLLM(ollamaConfig(), 'quick') as ChatOllama
    const deep = getLLM(ollamaConfig(), 'deep') as ChatOllama
    expect(quick.numCtx).toBe(16384)
    expect(deep.numCtx).toBe(32768)
  })

  it('respects config overrides (low-VRAM deployments)', () => {
    const llm = getLLM(
      ollamaConfig({ ollamaQuickNumCtx: 4096, ollamaDeepNumCtx: 8192 }),
      'deep'
    ) as ChatOllama
    expect(llm.numCtx).toBe(8192)
  })

  it('maps OLLAMA_*_NUM_CTX env vars into config', () => {
    process.env.OLLAMA_QUICK_NUM_CTX = '12288'
    process.env.OLLAMA_DEEP_NUM_CTX = '24576'
    try {
      clearConfigCache()
      const config = getConfig()
      expect(config.llm.ollamaQuickNumCtx).toBe(12288)
      expect(config.llm.ollamaDeepNumCtx).toBe(24576)
    } finally {
      delete process.env.OLLAMA_QUICK_NUM_CTX
      delete process.env.OLLAMA_DEEP_NUM_CTX
      clearConfigCache()
    }
  })
})

describe('LLM factory — current cloud provider contracts', () => {
  it('uses Kimi K2.6 thinking controls and max_completion_tokens', () => {
    const llm = getLLM(
      providerConfig('kimi', {
        kimiApiKey: 'test-key',
        kimiQuickModel: 'kimi-k2.6',
        kimiQuickMaxTokens: 8192,
      }),
      'quick',
    ) as ChatOpenAI
    const params = llm.invocationParams() as Record<string, unknown>

    expect(params.temperature).toBeUndefined()
    expect(params.max_tokens).toBeUndefined()
    expect(params.max_completion_tokens).toBe(8192)
    expect(params.thinking).toEqual({ type: 'disabled' })
  })

  it('uses Kimi K3 reasoning effort without legacy sampling parameters', () => {
    const llm = getLLM(
      providerConfig('kimi', {
        kimiApiKey: 'test-key',
        kimiDeepModel: 'kimi-k3',
        kimiDeepMaxTokens: 16384,
      }),
      'deep',
    ) as ChatOpenAI
    const params = llm.invocationParams() as Record<string, unknown>

    expect(params.temperature).toBeUndefined()
    expect(params.max_tokens).toBeUndefined()
    expect(params.max_completion_tokens).toBe(16384)
    expect(params.reasoning_effort).toBe('high')
  })

  it('can run Kimi K3 as a bounded extraction model', () => {
    const llm = getLLM(
      providerConfig('kimi', {
        kimiApiKey: 'test-key',
        kimiQuickMaxTokens: 8192,
      }),
      'quick',
      true,
      'kimi-k3',
      0.1,
    ) as ChatOpenAI
    const params = llm.invocationParams() as Record<string, unknown>

    expect(params.temperature).toBeUndefined()
    expect(params.max_completion_tokens).toBe(8192)
    expect(params.reasoning_effort).toBe('low')
  })

  it('omits deprecated sampling parameters for current Gemini models', () => {
    const llm = getLLM(
      providerConfig('google', {
        googleApiKey: 'test-key',
        geminiQuickModel: 'gemini-3.5-flash-lite',
      }),
      'quick',
    ) as ChatGoogleGenerativeAI

    expect(llm.temperature).toBeUndefined()
  })
})


describe('Kimi billing transport', () => {
  it('surfaces a billing 429 after one HTTP attempt instead of retrying inside the SDK', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Account suspended due to insufficient balance, please recharge', type: 'insufficient_quota' },
    }), { status: 429, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', transport)
    const llm = getLLM(providerConfig('kimi', { kimiApiKey: 'test-key', kimiQuickModel: 'kimi-k2.6' }), 'quick') as ChatOpenAI
    await expect(llm.invoke('Local transport fixture')).rejects.toThrow(/insufficient balance/)
    expect(transport).toHaveBeenCalledTimes(1)
  })
})
