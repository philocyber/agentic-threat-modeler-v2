import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { threatModels } from '@/lib/db/schema.sqlite'
import { createLocalProject } from '@/lib/workspace/local-project'
import { runWithWorkspace } from '@/lib/workspace/context'
import { getStorage, closeAllWorkspaceStorage } from '@/lib/storage/context'
import {
  claimNextThreatModelRun,
  claimThreatModelRun,
  completeThreatModelRun,
  createThreatModel,
  failThreatModelRun,
  getThreatModel,
  reapStaleThreatModelHeartbeats,
  requestThreatModelCancellation,
  touchThreatModelHeartbeat,
} from '../threat-models'
import {
  initRunArtifacts,
  readPhaseCheckpoints,
  recordPhaseOutput,
  resumableCheckpointPhases,
  failRunArtifacts,
} from '@/lib/workspace/run-artifacts'
import { getRunArtifactText } from '@/lib/storage/artifacts'

const originalRoot = process.env.AGENTICTM_WORKSPACE_ROOT
let testRoot: string | undefined

afterEach(async () => {
  closeAllWorkspaceStorage()
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
  if (originalRoot === undefined) delete process.env.AGENTICTM_WORKSPACE_ROOT
  else process.env.AGENTICTM_WORKSPACE_ROOT = originalRoot
})

function sqliteDb() {
  const storage = getStorage()
  if (storage.kind !== 'sqlite') throw new Error('expected sqlite storage')
  return storage.db
}

describe('pipeline lease fencing', () => {
  it('preserves elapsed time for a failed run without permitting a different worker to overwrite it', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-lease-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Failure timing' })
    await runWithWorkspace(project, async () => {
      await createThreatModel({ id: 'tm_failure_time', title: 'Synthetic', input: 'Fixture', versionHash: 'a'.repeat(64), status: 'pending' })
      expect(await claimThreatModelRun('tm_failure_time', 'worker-a')).toBe(true)
      expect(await failThreatModelRun('tm_failure_time', 'Unavailable', 'worker-b', 1_000)).toBe(false)
      expect(await failThreatModelRun('tm_failure_time', 'Unavailable', 'worker-a', 1444_558)).toBe(true)
      expect(await getThreatModel('tm_failure_time')).toMatchObject({ status: 'failed', executionTimeSeconds: 1445, errorMessage: 'Unavailable' })
    })
  })

  it('lets only one worker claim the same run', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-lease-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Dual Claim' })

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_dual',
        title: 'Dual',
        input: 'Architecture input',
        versionHash: 'a'.repeat(64),
        status: 'pending',
      })
      const [first, second] = await Promise.all([
        claimThreatModelRun('tm_dual', 'worker-a'),
        claimThreatModelRun('tm_dual', 'worker-b'),
      ])
      expect([first, second].filter(Boolean)).toHaveLength(1)
      const owner = (await getThreatModel('tm_dual'))?.workerInstanceId
      expect(owner === 'worker-a' || owner === 'worker-b').toBe(true)
      expect(await claimThreatModelRun('tm_dual', 'worker-a')).toBe(false)
      expect(await claimThreatModelRun('tm_dual', 'worker-b')).toBe(false)
    })
  })

  it('returns a single id from concurrent claimNext calls', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-lease-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Claim Next' })

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_next',
        title: 'Next',
        input: 'Architecture input',
        versionHash: 'b'.repeat(64),
        status: 'pending',
      })
      const claimed = await Promise.all([
        claimNextThreatModelRun('worker-a'),
        claimNextThreatModelRun('worker-b'),
      ])
      expect(claimed.filter(Boolean)).toEqual(['tm_next'])
    })
  })

  it('requeues an expired lease without failing the run', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-lease-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Expired Lease' })

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_expired',
        title: 'Expired',
        input: 'Architecture input',
        versionHash: 'c'.repeat(64),
        status: 'pending',
      })
      expect(await claimThreatModelRun('tm_expired', 'worker-a')).toBe(true)
      await sqliteDb().update(threatModels).set({ leaseExpiresAt: new Date(0) }).where(eq(threatModels.id, 'tm_expired'))
      const reaped = await reapStaleThreatModelHeartbeats(45_000)
      expect(reaped.map((row) => row.id)).toContain('tm_expired')
      const pending = await getThreatModel('tm_expired')
      expect(pending?.status).toBe('pending')
      expect(pending?.workerInstanceId).toBeNull()
      expect(await claimThreatModelRun('tm_expired', 'worker-b')).toBe(true)
      expect((await getThreatModel('tm_expired'))?.workerInstanceId).toBe('worker-b')
      expect(await touchThreatModelHeartbeat('tm_expired', 'worker-a')).toBe(false)
    })
  })

  it('lets a second worker reclaim an expired running lease and reuse only checksummed phases', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-lease-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Resume Prefix' })

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_resume_lease',
        title: 'Resume',
        input: 'Architecture input',
        versionHash: 'd'.repeat(64),
        status: 'pending',
      })
      expect(await claimThreatModelRun('tm_resume_lease', 'worker-a')).toBe(true)
      await initRunArtifacts('tm_resume_lease', 'Resume', {})
      await recordPhaseOutput('tm_resume_lease', 'architecture_parser', {
        systemDescription: 'desc', components: [], dataFlows: [], trustBoundaries: [],
      })
      await sqliteDb().update(threatModels).set({ leaseExpiresAt: new Date(0) }).where(eq(threatModels.id, 'tm_resume_lease'))
      expect(await claimThreatModelRun('tm_resume_lease', 'worker-b')).toBe(true)
      const checkpoints = await readPhaseCheckpoints('tm_resume_lease')
      expect(resumableCheckpointPhases(checkpoints)).toEqual(['architecture_parser'])
      expect(await touchThreatModelHeartbeat('tm_resume_lease', 'worker-a')).toBe(false)
    })
  })

  it('claims distinct pending rows under contention instead of returning empty', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-lease-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Two Pending' })

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_first',
        title: 'First',
        input: 'Architecture input',
        versionHash: 'e'.repeat(64),
        status: 'pending',
      })
      await createThreatModel({
        id: 'tm_second',
        title: 'Second',
        input: 'Architecture input',
        versionHash: 'f'.repeat(64),
        status: 'pending',
      })
      const claimed = await Promise.all([
        claimNextThreatModelRun('worker-a'),
        claimNextThreatModelRun('worker-b'),
      ])
      expect(new Set(claimed.filter(Boolean))).toEqual(new Set(['tm_first', 'tm_second']))
    })
  })

  it('does not let a displaced worker fail or complete the successor’s run', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-lease-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Fence Fail' })

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_fence',
        title: 'Fence',
        input: 'Architecture input',
        versionHash: 'a'.repeat(64),
        status: 'pending',
      })
      expect(await claimThreatModelRun('tm_fence', 'worker-a')).toBe(true)
      await sqliteDb().update(threatModels).set({ leaseExpiresAt: new Date(0) }).where(eq(threatModels.id, 'tm_fence'))
      expect(await claimThreatModelRun('tm_fence', 'worker-b')).toBe(true)
      expect(await failThreatModelRun('tm_fence', 'Lost pipeline lease', 'worker-a')).toBe(false)
      expect((await getThreatModel('tm_fence'))?.status).toBe('running')
      expect((await getThreatModel('tm_fence'))?.workerInstanceId).toBe('worker-b')
      await expect(completeThreatModelRun(
        'tm_fence',
        {
          systemDescription: 'desc',
          debateSummary: null,
          methodologiesUsed: ['STRIDE'],
          architectureJson: { systemDescription: 'desc' },
          totalThreats: 0,
          filteredThreats: 0,
          executionTimeSeconds: 1,
          pipelineErrors: null,
          currentPhase: 'pipeline_complete',
          workerInstanceId: 'worker-a',
        },
        [],
      )).rejects.toThrow(/superseded/)
      expect((await getThreatModel('tm_fence'))?.status).toBe('running')
    })
  })

  it('records failure artifacts after Stop has already marked the row failed', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-lease-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Cancel Artifacts' })

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_cancel_art',
        title: 'Cancel',
        input: 'Architecture input',
        versionHash: 'b'.repeat(64),
        status: 'pending',
      })
      expect(await claimThreatModelRun('tm_cancel_art', 'worker-a')).toBe(true)
      await initRunArtifacts('tm_cancel_art', 'Cancel', {})
      expect(await requestThreatModelCancellation('tm_cancel_art')).toBe(true)
      expect(await failThreatModelRun('tm_cancel_art', 'Stopped by user', 'worker-a')).toBe(false)
      expect((await getThreatModel('tm_cancel_art'))?.status).toBe('failed')
      await failRunArtifacts('tm_cancel_art', 'Stopped by user')
      const manifest = JSON.parse(await getRunArtifactText('tm_cancel_art', 'run.json') ?? '{}') as { status?: string; error?: string }
      expect(manifest.status).toBe('failed')
      expect(manifest.error).toBe('Stopped by user')
    })
  })
})
