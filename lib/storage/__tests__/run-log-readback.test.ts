import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET as getStatus } from '@/app/api/v1/analysis/[id]/status/route'
import { GET as getTelemetry } from '@/app/api/v1/analysis/[id]/telemetry/route'
import { createLocalProject } from '@/lib/workspace/local-project'
import { runWithWorkspace } from '@/lib/workspace/context'
import { closeAllWorkspaceStorage } from '@/lib/storage/context'
import { createThreatModel } from '@/lib/storage/threat-models'
import {
  appendRunProgress,
  appendRunTelemetry,
  getRunArtifact,
  getRunArtifactText,
  putRunArtifactContent,
} from '@/lib/storage/artifacts'

let testRoot: string | undefined

afterEach(async () => {
  closeAllWorkspaceStorage()
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
  vi.unstubAllEnvs()
})

async function freshProject() {
  testRoot = await mkdtemp(join(tmpdir(), 'agentictm-log-readback-'))
  vi.stubEnv('AGENTICTM_WORKSPACE_ROOT', testRoot)
  vi.stubEnv('DATABASE_URL', '')
  return createLocalProject({ name: 'Run log readback' })
}

describe('durable local run log readback', () => {
  it('replays worker-written logs through status and telemetry in a new request context', async () => {
    const project = await freshProject()
    const runId = 'tm_live_logs'
    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: runId, title: 'Log replay', input: 'Test architecture',
        versionHash: 'a'.repeat(64), status: 'running',
      })
      await appendRunProgress(runId, { phase: 'architecture_parser', status: 'start', timestamp: 1000 })
      await appendRunProgress(runId, { phase: 'architecture_parser', status: 'done', timestamp: 2000 })
      await appendRunProgress(runId, { phase: 'stride_analyst', status: 'start', timestamp: 3000 })
      await appendRunTelemetry(runId, { at: 3000, message: '[StrideAnalyst] evidence phase still running (30s)' })
      // Local append logs are mutable files, not checksummed checkpoint rows.
      expect(await getRunArtifact(runId, 'progress.jsonl')).toBeNull()
    })
    closeAllWorkspaceStorage()

    const request = (endpoint: string) => new NextRequest(`http://127.0.0.1:3000/api/v1/analysis/${runId}/${endpoint}`, {
      headers: { cookie: `agentictm_project=${project.id}` },
    })
    const context = { params: Promise.resolve({ id: runId }) }
    const statusResponse = await getStatus(request('status'), context)
    expect(statusResponse.status).toBe(200)
    const status = await statusResponse.json()
    expect(status.progress.events).toHaveLength(3)
    expect(status.progress.current_phase).toBe('stride_analyst')
    expect(status.progress.phases_completed).toContain('architecture_parser')

    const telemetryResponse = await getTelemetry(request('telemetry'), context)
    expect(telemetryResponse.status).toBe(200)
    const telemetry = await telemetryResponse.json()
    expect(telemetry.phases.map((phase: { phase: string }) => phase.phase)).toContain('stride_analyst')
    expect(telemetry.events.some((event: { message: string }) => event.message.includes('still running (30s)'))).toBe(true)
  })

  it.each(['progress.jsonl', 'telemetry.jsonl'])('reads appended %s events and treats only a missing file as empty', async (kind) => {
    const project = await freshProject()
    await runWithWorkspace(project, async () => {
      expect(await getRunArtifactText('tm_missing', kind)).toBeNull()
      const append = kind === 'progress.jsonl' ? appendRunProgress : appendRunTelemetry
      await append('tm_events', { message: 'first' })
      expect(await getRunArtifactText('tm_events', kind)).toContain('first')
      await append('tm_events', { message: 'second' })
      const events = (await getRunArtifactText('tm_events', kind))!.trim().split('\n').map((line) => JSON.parse(line))
      expect(events.map((event) => event.message)).toEqual(['first', 'second'])

      await mkdir(join(project.path, 'runs', 'tm_unreadable', kind), { recursive: true })
      await expect(getRunArtifactText('tm_unreadable', kind)).rejects.toThrow()
    })
  })

  it('keeps local logs isolated between projects', async () => {
    const first = await freshProject()
    const second = await createLocalProject({ name: 'Another project' })
    await runWithWorkspace(first, () => appendRunTelemetry('tm_shared_id', { message: 'first project only' }))
    expect(await runWithWorkspace(second, () => getRunArtifactText('tm_shared_id', 'telemetry.jsonl'))).toBeNull()
  })

  it('still rejects altered checkpoints and does not read uncatalogued checkpoint files', async () => {
    const project = await freshProject()
    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_checkpoint', title: 'Integrity', input: 'Test architecture',
        versionHash: 'b'.repeat(64), status: 'running',
      })
      await putRunArtifactContent({ runId: 'tm_checkpoint', kind: 'run.json', content: '{}', mimeType: 'application/json' })
      await writeFile(join(project.path, 'runs', 'tm_checkpoint', 'run.json'), '{"altered":true}')
      await expect(getRunArtifactText('tm_checkpoint', 'run.json')).rejects.toThrow('SHA-256')
      await writeFile(join(project.path, 'runs', 'tm_checkpoint', 'uncatalogued.json'), '{}')
      expect(await getRunArtifactText('tm_checkpoint', 'uncatalogued.json')).toBeNull()
    })
  })
})
