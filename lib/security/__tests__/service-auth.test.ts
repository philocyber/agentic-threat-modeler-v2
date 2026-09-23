import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { authorizeApiRequest } from '@/lib/security/service-auth'
import { actorCanAccess, runWithActor } from '@/lib/security/actor'
import { workspaceRoute } from '@/lib/local-route'

function request(path: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000${path}`, headers ? { headers } : undefined)
}

const originalEnv = { ...process.env }

afterEach(() => {
  if (originalEnv.DATABASE_URL) process.env.DATABASE_URL = originalEnv.DATABASE_URL
  else delete process.env.DATABASE_URL
  if (originalEnv.SERVICE_AUTH_TOKENS) process.env.SERVICE_AUTH_TOKENS = originalEnv.SERVICE_AUTH_TOKENS
  else delete process.env.SERVICE_AUTH_TOKENS
  if (originalEnv.SERVICE_AUTH_REQUIRED) process.env.SERVICE_AUTH_REQUIRED = originalEnv.SERVICE_AUTH_REQUIRED
  else delete process.env.SERVICE_AUTH_REQUIRED
})

describe('authorizeApiRequest', () => {
  it('keeps only the minimal liveness probe public', () => {
    process.env.SERVICE_AUTH_REQUIRED = 'true'
    process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5432/agentic-tm'
    delete process.env.SERVICE_AUTH_TOKENS
    expect(authorizeApiRequest(request('/api/health'), null).ok).toBe(true)
    const detailed = authorizeApiRequest(request('/api/v1/health'), null)
    expect(detailed.ok).toBe(false)
    if (!detailed.ok) expect(detailed.response.status).toBe(503)
  })

  it('fails closed on shared Postgres when service auth is required and tokens are missing', () => {
    process.env.SERVICE_AUTH_REQUIRED = 'true'
    process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5432/agentic-tm'
    delete process.env.SERVICE_AUTH_TOKENS
    const result = authorizeApiRequest(request('/api/v1/results'), null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(503)
  })

  it('rejects missing or wrong bearer tokens when tokens are configured', () => {
    process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5432/agentic-tm'
    process.env.SERVICE_AUTH_TOKENS = 'correct-token'
    expect(authorizeApiRequest(request('/api/v1/results'), null).ok).toBe(false)
    expect(
      authorizeApiRequest(request('/api/v1/results', { authorization: 'Bearer wrong-token' }), null).ok,
    ).toBe(false)
    const allowed = authorizeApiRequest(
      request('/api/v1/results', { authorization: 'Bearer correct-token' }),
      null,
    )
    expect(allowed.ok).toBe(true)
    if (allowed.ok) expect(allowed.actor.kind).toBe('token')
  })

  it('derives distinct stable principals for two bearer tokens', () => {
    process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5432/agentic-tm'
    process.env.SERVICE_AUTH_TOKENS = 'alice-token,bob-token'
    const alice = authorizeApiRequest(request('/api/v1/results', { authorization: 'Bearer alice-token' }), null)
    const bob = authorizeApiRequest(request('/api/v1/results', { authorization: 'Bearer bob-token' }), null)
    expect(alice.ok).toBe(true)
    expect(bob.ok).toBe(true)
    if (alice.ok && bob.ok) {
      expect(alice.actor).toMatchObject({ kind: 'token' })
      expect(bob.actor).toMatchObject({ kind: 'token' })
      expect(alice.actor.id).not.toBe(bob.actor.id)
    }
  })

  it('does not let a residual local workspace bypass service bearer auth', () => {
    process.env.SERVICE_AUTH_REQUIRED = 'true'
    process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5432/agentic-tm'
    process.env.SERVICE_AUTH_TOKENS = 'correct-token'
    const result = authorizeApiRequest(request('/api/v1/results'), {
      schemaVersion: 1,
      id: '11111111-1111-1111-1111-111111111111',
      name: 'local',
      slug: 'local',
      createdAt: '2026-01-01T00:00:00.000Z',
      database: 'project.db',
      ragMode: 'global',
      path: '/tmp/proj',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })
})

describe('actorCanAccess', () => {
  it('hides records owned by another token principal', () => {
    const allowed = runWithActor({ id: 'alice', kind: 'token' }, () => actorCanAccess('alice'))
    const denied = runWithActor({ id: 'alice', kind: 'token' }, () => actorCanAccess('bob'))
    expect(allowed).toBe(true)
    expect(denied).toBe(false)
  })
})

describe('workspaceRoute mutation boundary', () => {
  it('allows a valid remote bearer mutation that does not use ambient credentials', async () => {
    process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5432/agentic-tm'
    process.env.SERVICE_AUTH_TOKENS = 'machine-token'
    const route = workspaceRoute(async () => Response.json({ ok: true }))
    const response = await route(new NextRequest('https://service.example/api/v1/analyze', {
      method: 'POST',
      headers: { authorization: 'Bearer machine-token', origin: 'https://caller.example' },
    }), { params: Promise.resolve({}) })
    expect(response.status).toBe(200)
  })

  it('rejects a remote mutation from a local actor', async () => {
    delete process.env.DATABASE_URL
    delete process.env.SERVICE_AUTH_TOKENS
    const route = workspaceRoute(async () => Response.json({ ok: true }))
    const response = await route(new NextRequest('https://service.example/api/v1/analyze', {
      method: 'POST',
      headers: { origin: 'https://caller.example' },
    }), { params: Promise.resolve({}) })
    expect(response.status).toBe(403)
  })
})
