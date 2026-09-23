import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, PUT, DELETE } from '@/app/api/v1/llm/credentials/route'
import { saveProviderCredentials } from '@/lib/llm/provider-credentials'
import { checkProviderKey } from '@/lib/llm/check-key'
vi.mock('@/lib/workspace/request', () => ({ resolveRequestWorkspace: async () => null }))
vi.mock('@/lib/llm/check-key', () => ({ checkProviderKey: vi.fn(async () => ({ ok: true, summary: 'Synthetic check', meta: { credentialsValid: true } })) }))
vi.mock('@/lib/llm/provider-credentials', () => ({
  saveProviderCredentials: vi.fn(async () => {}), removeProviderCredentials: vi.fn(async () => {}),
  getProviderCredentialStatus: async () => ({}), withProviderCredentials: (config: unknown) => config,
}))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('CREDENTIALS_READ_ONLY', '')
})
afterEach(() => vi.unstubAllEnvs())
const context = { params: Promise.resolve({}) }
function request(method: string, origin = 'http://127.0.0.1:3000') {
  // Next can expose the internal bind authority while Host remains browser-facing.
  return new NextRequest('http://localhost:8080/api/v1/llm/credentials', {
    method, headers: { host: '127.0.0.1:3000', origin, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ provider: 'google', apiKey: 'synthetic-local-value' }) }),
  })
}
it('uses the shared browser-facing origin check when Next normalizes the URL', async () => {
  expect((await PUT(request('PUT'), context)).status).toBe(200)
  expect(saveProviderCredentials).toHaveBeenCalledOnce()
  expect((await PUT(request('PUT', 'https://untrusted.example'), context)).status).toBe(403)
  expect(saveProviderCredentials).toHaveBeenCalledOnce()
})
it('rejects container credential changes before validation or persistence', async () => {
  vi.stubEnv('CREDENTIALS_READ_ONLY', 'true')
  expect((await PUT(request('PUT'), context)).status).toBe(403)
  expect((await DELETE(request('DELETE'), context)).status).toBe(403)
  expect(checkProviderKey).not.toHaveBeenCalled()
  expect(saveProviderCredentials).not.toHaveBeenCalled()
})
it('tells the browser when credentials are managed by the installer', async () => {
  vi.stubEnv('CREDENTIALS_READ_ONLY', 'true')
  const response = await GET(request('GET'), context)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ readOnly: true })
})
