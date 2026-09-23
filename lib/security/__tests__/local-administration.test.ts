import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { localAdministrationRoute } from '@/lib/local-route'

vi.mock('@/lib/workspace/request', () => ({ resolveRequestWorkspace: async () => null }))
afterEach(() => vi.unstubAllEnvs())

describe('global administration boundary', () => {
  it('rejects each authenticated service principal before running a global mutation', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/test')
    vi.stubEnv('SERVICE_AUTH_TOKENS', 'analysis-one,analysis-two')
    const handler = vi.fn(() => Response.json({ changed: true }))
    const route = localAdministrationRoute(handler)
    for (const token of ['analysis-one', 'analysis-two']) {
      const response = await route(new NextRequest('https://service.example/api/v1/knowledge', {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      }), { params: Promise.resolve({}) })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'LOCAL_ADMINISTRATION_ONLY' })
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('allows a local operator but preserves same-origin mutation checks', async () => {
    vi.stubEnv('DATABASE_URL', '')
    const handler = vi.fn(() => Response.json({ changed: true }))
    const route = localAdministrationRoute(handler)
    const local = await route(new NextRequest('http://127.0.0.1:3000/api/v1/knowledge', {
      method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    }), { params: Promise.resolve({}) })
    expect(local.status).toBe(200)
    const remote = await route(new NextRequest('http://127.0.0.1:3000/api/v1/knowledge', {
      method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'https://untrusted.example' },
    }), { params: Promise.resolve({}) })
    expect(remote.status).toBe(403)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
