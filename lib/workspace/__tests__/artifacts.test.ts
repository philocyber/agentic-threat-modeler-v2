import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteDatabase } from '@/lib/db/sqlite'
import { artifacts, uploads } from '@/lib/db/schema.sqlite'
import { createLocalProject } from '@/lib/workspace/local-project'
import { runWithWorkspace } from '@/lib/workspace/context'
import { resolveWorkspacePath, sha256Hex } from '@/lib/workspace/artifacts'
import * as disk from '@/lib/workspace/artifacts'
import {
  failRunArtifacts,
  finalizeRunArtifacts,
  initRunArtifacts,
  readFinalReportArtifact,
  readFinalThreatsArtifact,
  readPhaseCheckpoints,
  recordPhaseOutput,
  recordRunProgress,
  resumableCheckpointPhases,
} from '@/lib/workspace/run-artifacts'
import { createUpload, getUploadsByIds } from '@/lib/storage/uploads'
import { getRunArtifact } from '@/lib/storage/artifacts'
import {
  claimThreatModelRun,
  createThreatModel,
  completeThreatModelRun,
  failThreatModelRun,
  getThreatModel,
} from '@/lib/storage/threat-models'
import { CheckpointWriteError } from '@/lib/pipeline/checkpoint-error'
import { closeAllWorkspaceStorage } from '@/lib/storage/context'
import { createSourceEvidence } from '@/lib/architecture/source-evidence'

const originalRoot = process.env.AGENTICTM_WORKSPACE_ROOT
let testRoot: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  closeAllWorkspaceStorage()
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
  if (originalRoot === undefined) delete process.env.AGENTICTM_WORKSPACE_ROOT
  else process.env.AGENTICTM_WORKSPACE_ROOT = originalRoot
})

async function freshProject(name: string) {
  testRoot = await mkdtemp(join(tmpdir(), 'agentictm-artifacts-'))
  process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
  return createLocalProject({ name })
}

describe('workspace path safety', () => {
  it('rejects traversal outside the workspace', async () => {
    const project = await freshProject('Path Safety')
    expect(() => resolveWorkspacePath(project, '..', 'escape.txt')).toThrow('Invalid workspace path')
    expect(() => resolveWorkspacePath(project, 'runs', '..', '..', 'escape.txt')).toThrow(
      'Invalid workspace path',
    )
    expect(resolveWorkspacePath(project, 'runs', 'abc', 'run.json')).toBe(
      join(project.path, 'runs', 'abc', 'run.json'),
    )
  })
})

describe('uploads as files', () => {
  it('stores content in inputs/ with SHA-256 and hydrates it on read', async () => {
    const project = await freshProject('Upload Files')

    await runWithWorkspace(project, async () => {
      await createUpload({
        id: 'upload-file-1',
        originalName: 'rfc.md',
        mediaType: 'text/markdown',
        content: '# RFC content',
        size: 14,
        expiresAt: new Date(Date.now() + 60_000),
      })
    })

    const extracted = await readFile(join(project.path, 'inputs', 'upload-file-1', 'extracted.txt'), 'utf8')
    expect(extracted).toBe('# RFC content')

    const manifest = JSON.parse(
      await readFile(join(project.path, 'inputs', 'upload-file-1', 'manifest.json'), 'utf8'),
    )
    expect(manifest.sha256).toBe(sha256Hex('# RFC content'))
    expect(manifest.originalName).toBe('rfc.md')

    const database = createSqliteDatabase(join(project.path, project.database))
    try {
      const rows = await database.select().from(uploads)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.content).toBe('')
      expect(rows[0]?.sha256).toBe(sha256Hex('# RFC content'))
      expect(rows[0]?.relativePath).toBe('inputs/upload-file-1')
    } finally {
      database.$client.close()
    }

    await runWithWorkspace(project, async () => {
      const hydrated = await getUploadsByIds(['upload-file-1'])
      expect(hydrated[0]?.content).toBe('# RFC content')
    })
  })

  it('treats an altered upload as corruption', async () => {
    const project = await freshProject('Upload Integrity')
    await runWithWorkspace(project, () => createUpload({
      id: 'upload-corrupt',
      originalName: 'input.txt',
      mediaType: 'text/plain',
      content: 'original',
      size: 8,
      expiresAt: new Date(Date.now() + 60_000),
    }))
    await writeFile(join(project.path, 'inputs', 'upload-corrupt', 'extracted.txt'), 'altered')
    await expect(runWithWorkspace(project, () => getUploadsByIds(['upload-corrupt'])))
      .rejects.toThrow(/integrity verification/i)
  })
})

describe('run artifacts', () => {
  it.each(['completed', 'partial'] as const)('persists %s status consistently in run artifacts', async (status) => {
    const project = await freshProject('Run Artifacts')

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_artifacts',
        title: 'Artifacts',
        input: 'Architecture input',
        versionHash: 'a'.repeat(64),
        status: 'pending',
      })

      await claimThreatModelRun('tm_artifacts', 'worker-test')
      await initRunArtifacts('tm_artifacts', 'Artifacts', { enabledAnalysts: ['stride'] })
      await recordRunProgress('tm_artifacts', {
        phase: 'stride_analyst',
        status: 'start',
        timestamp: Date.now(),
      })
      await recordRunProgress('tm_artifacts', {
        phase: 'stride_analyst',
        status: 'done',
        timestamp: Date.now(),
      })

      await completeThreatModelRun(
        'tm_artifacts',
        {
          systemDescription: 'desc',
          debateSummary: null,
          methodologiesUsed: ['STRIDE'],
          architectureJson: { systemDescription: 'desc', components: [], dataFlows: [], trustBoundaries: [] },
          totalThreats: 1,
          filteredThreats: 0,
          executionTimeSeconds: 5,
          pipelineErrors: status === 'partial' ? ['Provider billing blocked'] : null,
          status,
          currentPhase: 'pipeline_complete',
          workerInstanceId: 'worker-test',
        },
        [
          {
            id: 'THR-art-1',
            threatModelId: 'tm_artifacts',
            title: 'Spoofing risk',
            description: 'desc',
            severity: 'HIGH',
          } as never,
        ],
      )

      await finalizeRunArtifacts(
        'tm_artifacts',
        { systemDescription: 'desc', components: [], dataFlows: [], trustBoundaries: [] },
        [{ id: 'THR-art-1', title: 'Spoofing risk' }],
        { totalThreats: 1, durationMs: 5000 },
        undefined,
        status,
      )
    })

    const runDir = join(project.path, 'runs', 'tm_artifacts')
    const manifest = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'))
    expect(manifest.status).toBe(status)
    expect(manifest.systemName).toBe('Artifacts')
    expect(manifest.summary.totalThreats).toBe(1)

    const progress = await readFile(join(runDir, 'progress.jsonl'), 'utf8')
    const events = progress.trim().split('\n').map((line) => JSON.parse(line))
    expect(events).toHaveLength(2)
    expect(events[0].phase).toBe('stride_analyst')
    expect(events[0].at).toBeDefined()

    const architecture = JSON.parse(await readFile(join(runDir, 'architecture.json'), 'utf8'))
    expect(architecture.systemDescription).toBe('desc')

    const threatsFile = JSON.parse(await readFile(join(runDir, 'threats.json'), 'utf8'))
    expect(threatsFile).toHaveLength(1)

    const report = await readFile(join(runDir, 'report.md'), 'utf8')
    expect(report).toContain('# Threat Model: Artifacts')

    const recovered = await runWithWorkspace(project, async () => ({
      threats: await readFinalThreatsArtifact('tm_artifacts'),
      report: await readFinalReportArtifact('tm_artifacts'),
    }))
    expect(recovered.threats).toHaveLength(1)
    expect(recovered.threats?.[0]?.title).toBe('Spoofing risk')
    expect(recovered.report).toContain('# Threat Model: Artifacts')

    const database = createSqliteDatabase(join(project.path, project.database))
    try {
      const rows = await database.select().from(artifacts)
      const kinds = rows.map((row) => row.kind).sort()
      expect(kinds).toEqual(['architecture', 'quality', 'report', 'run.json', 'threats'])
      for (const row of rows) {
        expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(row.relativePath.startsWith('runs/tm_artifacts/')).toBe(true)
      }
    } finally {
      database.$client.close()
    }
  })

  it('records failures in run.json', async () => {
    const project = await freshProject('Run Failure')

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_failed',
        title: 'Failure case',
        input: 'Architecture input',
        versionHash: 'a'.repeat(64),
        status: 'pending',
      })
      await initRunArtifacts('tm_failed', 'Failure case', {})
      await failRunArtifacts('tm_failed', 'LLM unavailable')
    })

    const manifest = JSON.parse(
      await readFile(join(project.path, 'runs', 'tm_failed', 'run.json'), 'utf8'),
    )
    expect(manifest.status).toBe('failed')
    expect(manifest.error).toBe('LLM unavailable')
    expect(manifest.finishedAt).toBeDefined()
  })

  it('restores source coverage with findings and blocks stale downstream reuse when coverage is missing', async () => {
    const project = await freshProject('Source Coverage Resume')
    await runWithWorkspace(project, async () => {
      const runId = 'tm_source_resume'
      await createThreatModel({ id: runId, title: 'Source resume', input: 'Source', versionHash: 'b'.repeat(64), status: 'pending' })
      await initRunArtifacts(runId, 'Source resume', {})
      const sourceEvidence = createSourceEvidence('# First\nOriginal fact.\n# Second\nQualifying control.')
      const ids = sourceEvidence.sections.map(section => section.id)
      sourceEvidence.extraction.attempted = ids
      await recordPhaseOutput(runId, 'architecture_parser', { systemDescription: 'desc', components: [], dataFlows: [], trustBoundaries: [], sourceEvidence })
      for (const phase of ['stride_analyst', 'pasta_analyst', 'attack_tree_analyst']) {
        await recordPhaseOutput(runId, phase, { threats: [], sourceDelivery: ids })
      }
      await recordPhaseOutput(runId, 'pre_dedup', { threatsKept: [], filteredCount: 0 })
      const complete = await readPhaseCheckpoints(runId)
      expect(complete.architecture?.sourceEvidence?.analystDelivery).toEqual({ stride: ids, pasta: ids, attack_tree: ids })
      expect(resumableCheckpointPhases(complete)).toContain('pre_dedup')

      // A valid empty findings list alone does not establish source delivery.
      for (const incomplete of [[], { threats: [], sourceDelivery: ids.slice(1) }]) {
        await recordPhaseOutput(runId, 'stride_analyst', incomplete)
        const restored = await readPhaseCheckpoints(runId)
        expect(restored.strideThreats).toEqual([])
        expect(resumableCheckpointPhases(restored)).not.toContain('stride_analyst')
        expect(resumableCheckpointPhases(restored)).not.toContain('pre_dedup')
        expect(resumableCheckpointPhases(restored)).toContain('pasta_analyst')
      }
      // Legacy runs may have saved verified delivery only in the final artifact.
      await recordPhaseOutput(runId, 'stride_analyst', [])
      await finalizeRunArtifacts(runId, complete.architecture, [], {}, undefined, 'partial')
      expect(resumableCheckpointPhases(await readPhaseCheckpoints(runId))).toContain('stride_analyst')
      await finalizeRunArtifacts(runId, {
        ...complete.architecture,
        sourceEvidence: { ...sourceEvidence, sections: [], analystDelivery: { stride: ids } },
      }, [], {}, undefined, 'partial')
      expect(resumableCheckpointPhases(await readPhaseCheckpoints(runId))).not.toContain('stride_analyst')
    })
  })

  it('restores only dependency-safe completed phase checkpoints', async () => {
    const project = await freshProject('Run Resume')

    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_resume',
        title: 'Resume case',
        input: 'Architecture input',
        versionHash: 'b'.repeat(64),
        status: 'pending',
      })
      await initRunArtifacts('tm_resume', 'Resume case', {})

      const architecture = {
        systemDescription: 'desc',
        components: [],
        dataFlows: [],
        trustBoundaries: [],
      }
      await recordPhaseOutput('tm_resume', 'architecture_parser', architecture)
      await recordPhaseOutput('tm_resume', 'stride_analyst', [])
      await recordPhaseOutput('tm_resume', 'pasta_analyst', [])
      await recordPhaseOutput('tm_resume', 'attack_tree_analyst', [])
      await recordPhaseOutput('tm_resume', 'pre_dedup', { threatsKept: [], filteredCount: 2 })
      await recordPhaseOutput('tm_resume', 'debate', [])

      const checkpoints = await readPhaseCheckpoints('tm_resume')
      expect(checkpoints.architecture?.systemDescription).toBe('desc')
      expect(checkpoints.preDedup?.filteredCount).toBe(2)
      expect(resumableCheckpointPhases(checkpoints)).toEqual([
        'architecture_parser',
        'stride_analyst',
        'pasta_analyst',
        'attack_tree_analyst',
        'pre_dedup',
        'debate',
      ])

      checkpoints.pastaThreats = null
      expect(resumableCheckpointPhases(checkpoints)).toEqual([
        'architecture_parser',
        'stride_analyst',
        'attack_tree_analyst',
      ])
    })
  })

  it('reuses upstream work but rejects old batch-dependent debate and downstream checkpoints', async () => {
    const project = await freshProject('Debate Policy Resume')
    await runWithWorkspace(project, async () => {
      const runId = 'tm_debate_policy'
      await createThreatModel({ id: runId, title: 'Debate policy', input: 'Architecture', versionHash: 'b'.repeat(64), status: 'pending' })
      await initRunArtifacts(runId, 'Debate policy', {})
      await recordPhaseOutput(runId, 'architecture_parser', { systemDescription: 'desc', components: [], dataFlows: [], trustBoundaries: [] })
      for (const phase of ['stride_analyst', 'pasta_analyst', 'attack_tree_analyst']) await recordPhaseOutput(runId, phase, [])
      await recordPhaseOutput(runId, 'pre_dedup', { threatsKept: [], filteredCount: 0 })
      await recordPhaseOutput(runId, 'threat_synthesizer', [])
      const prefix = 'Safeguard: blanket invalidation was treated as an inconsistent model response.'
      const round = { round: 1, redTeamArguments: '', blueTeamArguments: '', convergenceSignal: true,
        threatAssessments: [{ draftId: 'DRAFT-1', notes: prefix }, { draftId: 'DRAFT-2', notes: 'Rejected' }] }
      await recordPhaseOutput(runId, 'debate', { rounds: [round], complete: true })
      const old = await readPhaseCheckpoints(runId)
      expect(old.debateRounds).toBeNull()
      expect(resumableCheckpointPhases(old)).toEqual(['architecture_parser', 'stride_analyst', 'pasta_analyst', 'attack_tree_analyst', 'pre_dedup'])
      round.threatAssessments[1]!.notes = prefix
      await recordPhaseOutput(runId, 'debate', { rounds: [round], complete: true })
      expect(resumableCheckpointPhases(await readPhaseCheckpoints(runId))).toContain('debate')
    })
  })

  it('keeps the last checkpoint and its checksum when partial and complete writes overlap', async () => {
    const project = await freshProject('Ordered Phase Writes')
    await runWithWorkspace(project, async () => {
      const runId = 'tm_ordered_phase'
      await createThreatModel({ id: runId, title: 'Ordered phase', input: 'Architecture', versionHash: 'b'.repeat(64), status: 'pending' })
      const writes = Array.from({ length: 12 }, (_, i) => recordPhaseOutput(runId, 'debate', {
        rounds: [{ round: i + 1, threatAssessments: [], redTeamArguments: i === 11 ? 'final' : 'partial '.repeat(20_000), blueTeamArguments: '', convergenceSignal: true }],
        complete: i === 11,
      }))
      await Promise.all(writes)
      const checkpoint = await readPhaseCheckpoints(runId)
      expect(checkpoint.debateComplete).toBe(true)
      expect(checkpoint.debateRounds?.[0]?.round).toBe(12)
      expect(checkpoint.debateRounds?.[0]?.redTeamArguments).toBe('final')
    })
  })

  it('treats an altered checkpoint as corruption instead of an absent phase', async () => {
    const project = await freshProject('Checkpoint Integrity')
    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_corrupt_checkpoint',
        title: 'Corrupt checkpoint',
        input: 'Architecture input',
        versionHash: 'c'.repeat(64),
        status: 'pending',
      })
      await recordPhaseOutput('tm_corrupt_checkpoint', 'architecture_parser', {
        systemDescription: 'valid', components: [], dataFlows: [], trustBoundaries: [],
      })
    })
    await writeFile(
      join(project.path, 'runs', 'tm_corrupt_checkpoint', 'phases', 'architecture_parser.json'),
      '{"tampered":true}',
    )
    await expect(runWithWorkspace(project, () => readPhaseCheckpoints('tm_corrupt_checkpoint')))
      .rejects.toThrow(/corrupt.*SHA-256/i)
  })

  it('never resumes a degraded checkpoint or any downstream output derived from it', async () => {
    const project = await freshProject('Degraded Resume')
    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_degraded_resume',
        title: 'Degraded resume',
        input: 'Architecture input',
        versionHash: 'd'.repeat(64),
        status: 'pending',
      })
      await recordPhaseOutput('tm_degraded_resume', 'architecture_parser', {
        systemDescription: 'desc', components: [], dataFlows: [], trustBoundaries: [],
      })
      await recordPhaseOutput('tm_degraded_resume', 'stride_analyst', [])
      await recordPhaseOutput('tm_degraded_resume', 'pasta_analyst', [])
      await recordPhaseOutput('tm_degraded_resume', 'attack_tree_analyst', [])
      await recordPhaseOutput('tm_degraded_resume', 'pre_dedup', { threatsKept: [], filteredCount: 0 })
      await recordPhaseOutput('tm_degraded_resume', 'debate', { rounds: [], complete: true })
      await recordPhaseOutput('tm_degraded_resume', 'threat_synthesizer', [])
      await recordPhaseOutput('tm_degraded_resume', 'dread_validator', { threatsFinal: [], filteredCount: 0 })
      await recordPhaseOutput('tm_degraded_resume', 'dread_validator.degraded', { error: 'provider failed' })

      const checkpoints = await readPhaseCheckpoints('tm_degraded_resume')
      expect(checkpoints.degradedPhases).toEqual(['dread_validator'])
      expect(resumableCheckpointPhases(checkpoints)).toEqual([
        'architecture_parser',
        'stride_analyst',
        'pasta_analyst',
        'attack_tree_analyst',
        'pre_dedup',
        'debate',
        'threat_synthesizer',
      ])
    })
  })

  it('fails a run with a write error instead of completing it', async () => {
    const project = await freshProject('Checkpoint Write Failure')
    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_write_fail',
        title: 'Write fail',
        input: 'Architecture input',
        versionHash: 'e'.repeat(64),
        status: 'pending',
      })
      await claimThreatModelRun('tm_write_fail', 'worker-test')
      vi.spyOn(disk, 'writeArtifactAtomic').mockRejectedValue(new Error('ENOSPC'))
      await expect(recordPhaseOutput('tm_write_fail', 'stride_analyst', { threats: [] }))
        .rejects.toBeInstanceOf(CheckpointWriteError)
      expect((await getThreatModel('tm_write_fail'))?.status).toBe('running')
      await failThreatModelRun('tm_write_fail', 'Failed to record checkpoint stride_analyst: ENOSPC', 'worker-test')
      const failed = await getThreatModel('tm_write_fail')
      expect(failed?.status).toBe('failed')
      expect(failed?.errorMessage).toMatch(/Failed to record checkpoint/)
    })
  })

  it('keeps the catalog checksum before a terminal database status', async () => {
    const project = await freshProject('Flush Before Terminal')
    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_flush',
        title: 'Flush',
        input: 'Architecture input',
        versionHash: 'f'.repeat(64),
        status: 'pending',
      })
      await claimThreatModelRun('tm_flush', 'worker-test')
      await initRunArtifacts('tm_flush', 'Flush', {})
      await finalizeRunArtifacts(
        'tm_flush',
        { systemDescription: 'desc', components: [], dataFlows: [], trustBoundaries: [] },
        [],
        { totalThreats: 0 },
        undefined,
        'completed',
      )
      const catalog = await getRunArtifact('tm_flush', 'architecture')
      expect(catalog?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect((await getThreatModel('tm_flush'))?.status).toBe('running')
      await completeThreatModelRun(
        'tm_flush',
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
          workerInstanceId: 'worker-test',
        },
        [],
      )
      expect((await getThreatModel('tm_flush'))?.status).toBe('completed')
    })
  })

  it('does not resume an orphan tmp file as a checksummed phase', async () => {
    const project = await freshProject('Orphan Tmp')
    await runWithWorkspace(project, async () => {
      await createThreatModel({
        id: 'tm_tmp',
        title: 'Tmp',
        input: 'Architecture input',
        versionHash: 'a'.repeat(64),
        status: 'pending',
      })
      await recordPhaseOutput('tm_tmp', 'architecture_parser', {
        systemDescription: 'desc', components: [], dataFlows: [], trustBoundaries: [],
      })
      await writeFile(
        join(project.path, 'runs', 'tm_tmp', 'phases', 'stride_analyst.json.orphan.tmp'),
        '{"threats":[]}',
      )
      const checkpoints = await readPhaseCheckpoints('tm_tmp')
      expect(checkpoints.architecture?.systemDescription).toBe('desc')
      expect(checkpoints.strideThreats).toBeNull()
      expect(resumableCheckpointPhases(checkpoints)).toEqual(['architecture_parser'])
    })
  })
})
