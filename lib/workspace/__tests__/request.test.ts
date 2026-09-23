import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalProject } from '../local-project'
import { ACTIVE_PROJECT_COOKIE, resolveRequestWorkspace, setActiveProjectCookie } from '../request'

const originalRoot = process.env.AGENTICTM_WORKSPACE_ROOT
let testRoot: string | undefined

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
  if (originalRoot === undefined) delete process.env.AGENTICTM_WORKSPACE_ROOT
  else process.env.AGENTICTM_WORKSPACE_ROOT = originalRoot
})

async function freshRoot(): Promise<void> {
  testRoot = await mkdtemp(join(tmpdir(), 'agentictm-request-'))
  process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
}

describe('request workspace resolution', () => {
  it('writes and clears the active project cookie', () => {
    const selected = Response.json({ ok: true })
    setActiveProjectCookie(selected, '38e2a158-fc3c-4fc3-a42a-31c64ac3068c')
    expect(selected.headers.get('set-cookie')).toContain(
      `${ACTIVE_PROJECT_COOKIE}=38e2a158-fc3c-4fc3-a42a-31c64ac3068c`,
    )
    expect(selected.headers.get('set-cookie')).toContain('HttpOnly')

    const cleared = Response.json({ ok: true })
    setActiveProjectCookie(cleared, null)
    expect(cleared.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('uses the only local project when a direct request has no cookie', async () => {
    await freshRoot()
    const project = await createLocalProject({ name: 'Product Demo' })

    const resolved = await resolveRequestWorkspace(new NextRequest('http://localhost/results/demo'))

    expect(resolved?.id).toBe(project.id)
  })

  it('does not guess when multiple projects exist and no cookie is present', async () => {
    await freshRoot()
    await createLocalProject({ name: 'First' })
    await createLocalProject({ name: 'Second' })

    const resolved = await resolveRequestWorkspace(new NextRequest('http://localhost/results/demo'))

    expect(resolved).toBeNull()
  })

  it('honors the explicit project cookie when multiple projects exist', async () => {
    await freshRoot()
    await createLocalProject({ name: 'First' })
    const selected = await createLocalProject({ name: 'Second' })
    const request = new NextRequest('http://localhost/results/demo', {
      headers: { cookie: `${ACTIVE_PROJECT_COOKIE}=${selected.id}` },
    })

    const resolved = await resolveRequestWorkspace(request)

    expect(resolved?.id).toBe(selected.id)
  })
})
