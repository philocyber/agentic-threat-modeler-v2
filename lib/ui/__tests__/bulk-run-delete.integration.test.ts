import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, expect, it, vi } from 'vitest'
import { DELETE } from '@/app/api/v1/results/[id]/route'
import { createLocalProject } from '@/lib/workspace/local-project'
import { runWithWorkspace } from '@/lib/workspace/context'
import { createThreatModel, getThreatModel } from '@/lib/storage/threat-models'
import { closeAllWorkspaceStorage } from '@/lib/storage/context'
import { runBulkLifecycleAction } from '../bulk-run-lifecycle'

// PDF export belongs to GET and requires Next's server-only module loader.
// Keep deletion, authorization, storage and artifact removal real in this test.
vi.mock('@/lib/reports/philocyber-pdf', () => ({ generatePhiloCyberPdf: vi.fn() }))

let testRoot: string | undefined
afterEach(async () => {
  closeAllWorkspaceStorage()
  vi.unstubAllEnvs()
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
})

it('deletes all three selected scans through the real route at an IPv4 origin, preserving unselected scans', async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'agentictm-bulk-delete-'))
  vi.stubEnv('AGENTICTM_WORKSPACE_ROOT', testRoot)
  vi.stubEnv('DATABASE_URL', '')
  const project = await createLocalProject({ name: 'Origin regression fixture' })
  const targets = [
    { id: 'tm_origin_one', systemName: 'Temporary completed scan' },
    { id: 'tm_origin_two', systemName: 'Temporary failed scan' },
    { id: 'tm_origin_three', systemName: 'Third temporary scan' },
  ]
  const untouched = { id: 'tm_origin_untouched', systemName: 'Unselected scan' }
  await runWithWorkspace(project, async () => {
    for (const target of [...targets, untouched]) {
      await createThreatModel({
        id: target.id, title: target.systemName, input: 'Test architecture',
        versionHash: 'a'.repeat(64), status: target.id === 'tm_origin_two' ? 'failed' : 'completed',
      })
      const directory = join(project.path, 'runs', target.id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'report.md'), 'Temporary fixture report')
    }
  })

  const browserRequest = (origin: string) => async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:3000')
    const headers = new Headers(init?.headers)
    headers.set('host', url.host)
    headers.set('origin', origin)
    headers.set('sec-fetch-site', 'same-origin')
    headers.set('cookie', `agentictm_project=${project.id}`)
    return DELETE(new NextRequest(new Request(url, { ...init, headers })), {
      params: Promise.resolve({ id: url.pathname.split('/').at(-1)! }),
    })
  }

  // Even another loopback origin must not pass by claiming same-origin metadata.
  const rejected = await runBulkLifecycleAction(targets, 'delete', browserRequest('http://localhost:3000'))
  expect(rejected.succeeded).toHaveLength(0)
  expect(rejected.failed).toHaveLength(3)
  await runWithWorkspace(project, async () => {
    for (const target of targets) expect(await getThreatModel(target.id)).not.toBeNull()
  })

  const result = await runBulkLifecycleAction(targets, 'delete', browserRequest('http://127.0.0.1:3000'))
  expect(result).toEqual({ succeeded: targets, failed: [] })
  await runWithWorkspace(project, async () => {
    for (const target of targets) {
      expect(await getThreatModel(target.id)).toBeNull()
      await expect(access(join(project.path, 'runs', target.id))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await getThreatModel(untouched.id)).not.toBeNull()
    await access(join(project.path, 'runs', untouched.id, 'report.md'))
  })
})
