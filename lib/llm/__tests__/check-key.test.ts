import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkProviderKey } from '@/lib/llm/check-key'
import { getConfig, type AppConfig } from '@/lib/config'

function kimiConfig(): AppConfig {
  const base = getConfig()
  return {
    ...base,
    llm: {
      ...base.llm,
      provider: 'kimi',
      kimiApiKey: 'test-key',
      kimiBaseUrl: 'https://api.moonshot.ai/v1',
      kimiQuickModel: 'kimi-k2.6',
      kimiDeepModel: 'kimi-k3',
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('provider readiness checks', () => {
  it('uses model discovery and current Kimi request parameters', async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined
      requests.push({ url, ...(body ? { body } : {}) })
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'kimi-k2.6' }, { id: 'kimi-k3' }] }))
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    }))

    const result = await checkProviderKey('kimi', kimiConfig())

    expect(result.ok).toBe(true)
    expect(requests.filter((request) => request.url.endsWith('/models'))).toHaveLength(2)
    const completions = requests.filter((request) => request.url.endsWith('/chat/completions'))
    expect(completions[0]?.body).toMatchObject({
      model: 'kimi-k2.6',
      max_completion_tokens: 256,
      thinking: { type: 'disabled' },
    })
    expect(completions[0]?.body).not.toHaveProperty('max_tokens')
    expect(completions[0]?.body).not.toHaveProperty('temperature')
    expect(completions[1]?.body).toMatchObject({
      model: 'kimi-k3',
      max_completion_tokens: 256,
      reasoning_effort: 'low',
    })
  })

  it('preserves the sanitized provider error for diagnosis', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'kimi-k2.6' }, { id: 'kimi-k3' }] }))
      }
      return new Response(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'Unsupported parameter temperature' } }),
        { status: 400 },
      )
    }))

    const result = await checkProviderKey('kimi', kimiConfig())

    expect(result.ok).toBe(false)
    expect(result.details).toContain('invalid_request_error: Unsupported parameter temperature')
    expect(result.meta?.credentialsValid).toBe(true)
  })
})
