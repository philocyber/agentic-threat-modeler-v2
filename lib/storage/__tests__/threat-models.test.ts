import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteDatabase } from '@/lib/db/sqlite'
import { auditLogs, threatModels, threats } from '@/lib/db/schema.sqlite'
import { createLocalProject } from '@/lib/workspace/local-project'
import { runWithWorkspace } from '@/lib/workspace/context'
import {
  archiveThreatModel,
  claimThreatModelRun,
  completeThreatModelRun,
  createThreatModel,
  failThreatModelRun,
  getThreat,
  getThreatModel,
  isThreatModelCancellationRequested,
  listThreatModels,
  listThreats,
  permanentlyDeleteThreatModel,
  renameThreatModel,
  requestThreatModelCancellation,
  restoreThreatModel,
  touchThreatModelHeartbeat,
  updateThreat,
} from '../threat-models'
import { createUpload, getUploadsByIds } from '../uploads'
import { insertAuditLog } from '../audit'
import { closeAllWorkspaceStorage } from '../context'

const originalRoot = process.env.AGENTICTM_WORKSPACE_ROOT
let testRoot: string | undefined

afterEach(async () => {
  closeAllWorkspaceStorage()
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
  if (originalRoot === undefined) delete process.env.AGENTICTM_WORKSPACE_ROOT
  else process.env.AGENTICTM_WORKSPACE_ROOT = originalRoot
})

describe('workspace threat model storage', () => {
  it('lists analyses from the active project SQLite database', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-storage-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Payments API' })
    const database = createSqliteDatabase(join(project.path, project.database))

    try {
      await database.insert(threatModels).values({
        id: 'tm_local_1',
        title: 'Payments API',
        input: 'Architecture input',
        versionHash: 'a'.repeat(64),
        status: 'completed',
        totalThreats: 12,
        filteredThreats: 2,
        executionTimeSeconds: 42,
      })
    } finally {
      database.$client.close()
    }

    const results = await runWithWorkspace(project, () =>
      listThreatModels({ page: 1, limit: 20, status: 'completed' }),
    )

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'tm_local_1',
      systemName: 'Payments API',
      status: 'completed',
      totalThreats: 12,
      filteredThreats: 2,
      // The column stores seconds; the field name says so since the dashboard
      // was formatting it as milliseconds and rendering a 15-minute run as "1s".
      durationSeconds: 42,
    })
  })

  it('reads and updates project-scoped threat details', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-storage-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Threat Review' })
    const database = createSqliteDatabase(join(project.path, project.database))

    try {
      await database.insert(threatModels).values({
        id: 'tm_local_2',
        title: 'Threat Review',
        input: 'Architecture input',
        versionHash: 'b'.repeat(64),
        status: 'completed',
      })
      await database.insert(threats).values({
        id: 'THR-local-1',
        threatModelId: 'tm_local_2',
        title: 'Missing authorization',
        description: 'Object access is not authorized',
        severity: 'HIGH',
      })
    } finally {
      database.$client.close()
    }

    await runWithWorkspace(project, async () => {
      expect((await getThreatModel('tm_local_2'))?.title).toBe('Threat Review')
      expect(await listThreats('tm_local_2')).toHaveLength(1)
      const updated = await updateThreat('tm_local_2', 'THR-local-1', {
        reviewStatus: 'confirmed',
        reviewNotes: 'Validated manually',
        reviewedAt: new Date('2026-08-03T19:00:00.000Z'),
      })
      expect(updated?.reviewStatus).toBe('confirmed')
      expect((await getThreat('tm_local_2', 'THR-local-1'))?.reviewNotes).toBe('Validated manually')
    })
  })

  it('orders threats deterministically for a stable review inspector', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-storage-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Stable order' })
    const database = createSqliteDatabase(join(project.path, project.database))
    const createdAt = new Date('2026-08-11T12:00:00.000Z')

    try {
      await database.insert(threatModels).values({
        id: 'tm_ordered', title: 'Stable order', input: 'Architecture input', versionHash: 'o'.repeat(64), status: 'completed',
      })
      await database.insert(threats).values([
        { id: 'THR-b', threatModelId: 'tm_ordered', title: 'Second', description: 'Second', severity: 'HIGH', createdAt },
        { id: 'THR-a', threatModelId: 'tm_ordered', title: 'First', description: 'First', severity: 'HIGH', createdAt },
      ])
    } finally {
      database.$client.close()
    }

    await runWithWorkspace(project, async () => {
      expect((await listThreats('tm_ordered')).map((threat) => threat.id)).toEqual(['THR-a', 'THR-b'])
    })
  })

  it('archives, restores, and permanently deletes terminal runs', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-storage-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Lifecycle actions' })

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_lifecycle_actions',
        title: 'Lifecycle actions',
        input: 'Architecture input',
        versionHash: 'l'.repeat(64),
        status: 'completed',
      })

      expect(await archiveThreatModel('tm_lifecycle_actions')).toBe(true)
      expect(await listThreatModels({ page: 1, limit: 20 })).toHaveLength(0)
      expect((await listThreatModels({ page: 1, limit: 20, archived: true }))[0]?.id).toBe('tm_lifecycle_actions')

      expect(await restoreThreatModel('tm_lifecycle_actions')).toBe(true)
      expect((await listThreatModels({ page: 1, limit: 20 }))[0]?.id).toBe('tm_lifecycle_actions')

      expect((await permanentlyDeleteThreatModel('tm_lifecycle_actions'))?.id).toBe('tm_lifecycle_actions')
      expect(await getThreatModel('tm_lifecycle_actions')).toBeNull()
    })
  })

  it('renames a run title without changing its fingerprint or status', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-storage-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Rename title' })

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_rename_title',
        title: 'Example Service - Cursor provider debate full run',
        input: 'Architecture input',
        versionHash: 'n'.repeat(64),
        status: 'running',
      })

      expect(await renameThreatModel('tm_rename_title', 'Example Service (Cursor)')).toBe(true)
      const renamed = await getThreatModel('tm_rename_title')
      expect(renamed).toMatchObject({
        title: 'Example Service (Cursor)',
        versionHash: 'n'.repeat(64),
        status: 'running',
      })
      expect((await listThreatModels({ page: 1, limit: 20 }))[0]?.systemName).toBe('Example Service (Cursor)')
    })
  })

  it('archives and deletes a degraded run, and still refuses one in flight', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-storage-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Partial lifecycle' })

    await runWithWorkspace(project, async () => {
      // A run whose phases degraded is finished: it must clear the queue like
      // any other. Archiving used to reject it while delete accepted it, so
      // these runs accumulated with no way to get rid of them.
      await createThreatModel({
        id: 'tm_partial_lifecycle',
        title: 'Partial run',
        input: 'Architecture input',
        versionHash: 'p'.repeat(64),
        status: 'partial',
      })
      await createThreatModel({
        id: 'tm_running_lifecycle',
        title: 'Running run',
        input: 'Architecture input',
        versionHash: 'r'.repeat(64),
        status: 'running',
      })

      expect(await archiveThreatModel('tm_partial_lifecycle')).toBe(true)
      expect(await restoreThreatModel('tm_partial_lifecycle')).toBe(true)
      expect((await permanentlyDeleteThreatModel('tm_partial_lifecycle'))?.id).toBe('tm_partial_lifecycle')

      // A run still in flight stays protected.
      expect(await archiveThreatModel('tm_running_lifecycle')).toBe(false)
      expect(await permanentlyDeleteThreatModel('tm_running_lifecycle')).toBeNull()
    })
  })

  it('cancels only pending or running analyses in the active workspace', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-storage-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Cancellation' })
    const database = createSqliteDatabase(join(project.path, project.database))

    try {
      await database.insert(threatModels).values([
        {
          id: 'tm_running',
          title: 'Running',
          input: 'Architecture input',
          versionHash: 'c'.repeat(64),
          status: 'running',
        },
        {
          id: 'tm_completed',
          title: 'Completed',
          input: 'Architecture input',
          versionHash: 'd'.repeat(64),
          status: 'completed',
        },
      ])
    } finally {
      database.$client.close()
    }

    await runWithWorkspace(project, async () => {
      expect(await requestThreatModelCancellation('tm_running')).toBe(true)
      expect(await requestThreatModelCancellation('tm_completed')).toBe(false)
      expect((await getThreatModel('tm_running'))?.status).toBe('failed')
      expect((await getThreatModel('tm_completed'))?.status).toBe('completed')
    })
  })

  it('runs the full analysis lifecycle against the project SQLite database', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-storage-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Lifecycle' })

    await runWithWorkspace(project, async () => {
      await createUpload({
        id: 'upload-1',
        originalName: 'rfc.md',
        mediaType: 'text/markdown',
        content: '# RFC',
        size: 5,
        expiresAt: new Date(Date.now() + 60_000),
      })
      expect((await getUploadsByIds(['upload-1']))[0]?.content).toBe('# RFC')

      const created = await createThreatModel({
        id: 'tm_lifecycle',
        title: 'Lifecycle',
        input: 'Architecture input',
        versionHash: 'e'.repeat(64),
        status: 'pending',
      })
      expect(created.status).toBe('pending')

      expect(await claimThreatModelRun('tm_lifecycle', 'worker-test')).toBe(true)
      expect(await claimThreatModelRun('tm_lifecycle', 'worker-test')).toBe(false)
      expect(await touchThreatModelHeartbeat('tm_lifecycle', 'worker-test', 'stride_analyst')).toBe(true)
      expect(await isThreatModelCancellationRequested('tm_lifecycle')).toBe(false)

      await completeThreatModelRun(
        'tm_lifecycle',
        {
          systemDescription: 'desc',
          debateSummary: null,
          methodologiesUsed: ['STRIDE'],
          architectureJson: { systemDescription: 'desc' },
          totalThreats: 1,
          filteredThreats: 0,
          executionTimeSeconds: 10,
          pipelineErrors: null,
          currentPhase: 'pipeline_complete',
          workerInstanceId: 'worker-test',
        },
        [
          {
            id: 'THR-lifecycle-1',
            threatModelId: 'tm_lifecycle',
            title: 'Spoofing risk',
            description: 'desc',
            severity: 'HIGH',
          } as never,
        ],
      )

      const finished = await getThreatModel('tm_lifecycle')
      expect(finished?.status).toBe('completed')
      expect(finished?.totalThreats).toBe(1)
      expect(await listThreats('tm_lifecycle')).toHaveLength(1)

      await insertAuditLog({ eventType: 'analysis_completed', metadata: { id: 'tm_lifecycle' } })
    })

    const database = createSqliteDatabase(join(project.path, project.database))
    try {
      const audits = await database.select().from(auditLogs)
      expect(audits).toHaveLength(1)
      expect(audits[0]?.eventType).toBe('analysis_completed')
    } finally {
      database.$client.close()
    }
  })

  it('marks runs as failed without touching cancelled rows', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-storage-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Failures' })

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_fail',
        title: 'Fail',
        input: 'Architecture input',
        versionHash: 'f'.repeat(64),
        status: 'pending',
      })
      expect(await claimThreatModelRun('tm_fail', 'worker-test')).toBe(true)
      expect(await failThreatModelRun('tm_fail', 'LLM unavailable', 'worker-other')).toBe(false)
      expect((await getThreatModel('tm_fail'))?.status).toBe('running')
      expect(await failThreatModelRun('tm_fail', 'LLM unavailable', 'worker-test')).toBe(true)
      const failed = await getThreatModel('tm_fail')
      expect(failed?.status).toBe('failed')
      expect(failed?.errorMessage).toBe('LLM unavailable')
    })
  })
})
