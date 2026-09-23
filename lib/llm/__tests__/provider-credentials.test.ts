import { describe, expect, it } from 'vitest'
import { updateProviderEnvContent, withProviderCredentials } from '@/lib/llm/provider-credentials'
import { getConfig } from '@/lib/config'

describe('provider credential persistence', () => {
  it('replaces provider aliases without touching unrelated env values', () => {
    const original = [
      'DATABASE_URL="postgres://local"',
      'KIMI_API_KEY="old-value"',
      'OLLAMA_BASE_URL="http://localhost:11434"',
      '',
    ].join('\n')

    const updated = updateProviderEnvContent(original, 'kimi', {
      provider: 'kimi',
      apiKey: 'new$key"value',
      baseUrl: 'https://api.moonshot.ai/v1',
    })

    expect(updated).toContain('DATABASE_URL="postgres://local"')
    expect(updated).toContain('OLLAMA_BASE_URL="http://localhost:11434"')
    expect(updated).not.toContain('KIMI_API_KEY=')
    expect(updated).toContain('MOONSHOT_API_KEY="new\\$key\\"value"')
    expect(updated).toContain('KIMI_BASE_URL="https://api.moonshot.ai/v1"')
  })

  it('removes only the selected provider credentials', () => {
    const original = 'GOOGLE_API_KEY="google"\nMOONSHOT_API_KEY="kimi"\n'
    const updated = updateProviderEnvContent(original, 'google')

    expect(updated).not.toContain('GOOGLE_API_KEY')
    expect(updated).toContain('MOONSHOT_API_KEY="kimi"')
  })

  it('builds a validation config without mutating the cached base config', () => {
    const base = getConfig()
    const candidate = withProviderCredentials(base, { provider: 'google', apiKey: 'temporary-key' })

    expect(candidate.llm.googleApiKey).toBe('temporary-key')
    expect(base.llm.googleApiKey).not.toBe('temporary-key')
  })

  it('persists Cursor API keys without touching other providers', () => {
    const original = 'GOOGLE_API_KEY="google"\n'
    const updated = updateProviderEnvContent(original, 'cursor', {
      provider: 'cursor',
      apiKey: 'crsr_test',
    })
    expect(updated).toContain('GOOGLE_API_KEY="google"')
    expect(updated).toContain('CURSOR_API_KEY="crsr_test"')
  })
})
