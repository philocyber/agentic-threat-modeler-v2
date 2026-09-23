import { describe, it, expect } from 'vitest'
import { DEFAULT_PROVIDER_MODELS, isLLMProvider, LLM_PROVIDERS } from '@/lib/llm/providers'
import { isAllowedKimiBaseUrl } from '@/lib/config'

describe('LLM providers', () => {
  it('loads the LLM factory with compatible LangChain exports', async () => {
    await expect(import('@/lib/llm/factory')).resolves.toHaveProperty('getLLM')
  })

  it('lists expected providers', () => {
    expect(LLM_PROVIDERS).toEqual(['ollama', 'google', 'kimi', 'bedrock', 'cursor'])
  })

  it('validates provider ids', () => {
    expect(isLLMProvider('kimi')).toBe(true)
    expect(isLLMProvider('bedrock')).toBe(true)
    expect(isLLMProvider('openai')).toBe(false)
  })

  it('defaults both Cursor tiers to Grok 4.7', () => {
    expect(DEFAULT_PROVIDER_MODELS.cursor).toEqual({ quick: 'grok-4.7', deep: 'grok-4.7' })
  })

  it('only accepts approved Kimi API endpoints', () => {
    expect(isAllowedKimiBaseUrl('https://api.moonshot.ai/v1')).toBe(true)
    expect(isAllowedKimiBaseUrl('https://api.moonshot.cn/v1/')).toBe(true)
    expect(isAllowedKimiBaseUrl('https://example.test/v1')).toBe(false)
    expect(isAllowedKimiBaseUrl('http://api.moonshot.ai/v1')).toBe(false)
  })
})
