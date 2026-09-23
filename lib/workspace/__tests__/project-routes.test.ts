import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it } from 'vitest'
import { GET as getActiveProject } from '@/app/api/v1/projects/active/route'
import { POST as createProject } from '@/app/api/v1/projects/route'
import { ACTIVE_PROJECT_COOKIE } from '../request'

const originalRoot = process.env.AGENTICTM_WORKSPACE_ROOT
let testRoot: string | undefined
const routeContext = { params: Promise.resolve({}) }

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
  if (originalRoot === undefined) delete process.env.AGENTICTM_WORKSPACE_ROOT
  else process.env.AGENTICTM_WORKSPACE_ROOT = originalRoot
})

describe('local project routes', () => {
  it('creates and activates a project in one request', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-project-route-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot

    const created = await createProject(new NextRequest('http://localhost/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Payments API' }),
    }), routeContext)

    expect(created.status).toBe(201)
    const payload = await created.json() as { data: { id: string; name: string } }
    expect(payload.data.name).toBe('Payments API')
    expect(created.headers.get('set-cookie')).toContain(`${ACTIVE_PROJECT_COOKIE}=${payload.data.id}`)

    const active = await getActiveProject(new NextRequest('http://localhost/api/v1/projects/active', {
      headers: { cookie: `${ACTIVE_PROJECT_COOKIE}=${payload.data.id}` },
    }), routeContext)
    expect(active.status).toBe(200)
    await expect(active.json()).resolves.toMatchObject({
      data: { id: payload.data.id, name: 'Payments API' },
      requiresProject: false,
    })
  })
})
