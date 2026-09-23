import { logger } from '@/lib/logger'
import { CheckpointWriteError } from '@/lib/pipeline/checkpoint-error'
import { hasAnalystDelivery } from '@/lib/architecture/source-evidence'
import {
  appendRunProgress,
  appendRunTelemetry,
  getRunArtifact,
  getRunArtifactText,
  putRunArtifactContent,
} from '@/lib/storage/artifacts'
import { getThreatModel, listThreats } from '@/lib/storage/threat-models'
import { generateMarkdownFromDB } from '@/lib/agents/report-generator'
import type { ProgressEvent } from '@/lib/models/types'
import { sha256Hex } from './artifacts'
import type { RAGTraceSnapshot } from '@/lib/rag/trace'
import { evaluateThreatQuality } from '@/lib/evaluation/threat-quality'
import type { ArchitectureData, DebateRound, RawThreat, UnifiedThreat } from '@/lib/models/types'

type RunManifest = {
  runId: string
  systemName: string
  status: 'running' | 'completed' | 'partial' | 'failed'
  startedAt: string
  finishedAt?: string
  config?: unknown
  summary?: Record<string, unknown>
  error?: string
  resume?: { from: string; reusedPhases: number; phaseNames?: string[] }
}

const phaseWrites = new Map<string, Promise<void>>()

async function writeManifest(runId: string, patch: Partial<RunManifest>): Promise<void> {
  let current: RunManifest | null = null
  try {
    const existing = await getRunArtifactText(runId, 'run.json')
    if (existing) current = JSON.parse(existing) as RunManifest
  } catch (err) {
    if (err instanceof CheckpointWriteError) throw err
    throw new CheckpointWriteError(
      `Failed to read run manifest: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  const next: RunManifest = {
    runId,
    systemName: patch.systemName ?? current?.systemName ?? '',
    status: patch.status ?? current?.status ?? 'running',
    startedAt: current?.startedAt ?? patch.startedAt ?? new Date().toISOString(),
  }
  const config = patch.config ?? current?.config
  if (config !== undefined) next.config = config
  const finishedAt = patch.finishedAt ?? current?.finishedAt
  if (finishedAt) next.finishedAt = finishedAt
  const summary = patch.summary ?? current?.summary
  if (summary) next.summary = summary
  const error = patch.error ?? current?.error
  if (error) next.error = error
  const resume = patch.resume ?? current?.resume
  if (resume) next.resume = resume
  await putRunArtifactContent({
    runId,
    kind: 'run.json',
    relativePath: `runs/${runId}/run.json`,
    mimeType: 'application/json',
    content: JSON.stringify(next, null, 2),
  })
}

export async function recordRunResume(
  runId: string,
  resume: { from: string; reusedPhases: number; phaseNames?: string[] },
): Promise<void> {
  await writeManifest(runId, { resume })
}

export async function initRunArtifacts(
  runId: string,
  systemName: string,
  config: unknown,
): Promise<void> {
  await writeManifest(runId, {
    runId,
    systemName,
    status: 'running',
    startedAt: new Date().toISOString(),
    config,
  })
}

export async function recordRunProgress(runId: string, event: ProgressEvent): Promise<void> {
  await appendRunProgress(runId, event as unknown as Record<string, unknown>)
}

export async function recordRunTelemetry(runId: string, event: Record<string, unknown>): Promise<void> {
  await appendRunTelemetry(runId, event)
}

export async function recordAttemptArtifact(
  runId: string,
  diagnostic: Record<string, unknown>,
  rejectedResponse?: string,
): Promise<void> {
  await appendRunTelemetry(runId, { type: 'llm_attempt', ...diagnostic })
  if (!rejectedResponse) return
  const stamp = String(diagnostic.at ?? Date.now()).replace(/[^0-9T-]/g, '').slice(0, 20) || String(Date.now())
  await putRunArtifactContent({
    runId,
    kind: `attempt:${stamp}:${String(diagnostic.phase ?? 'unknown')}`,
    relativePath: `runs/${runId}/attempts/${stamp}.txt`,
    mimeType: 'text/plain',
    content: rejectedResponse,
  })
}

/**
 * Writes one phase's output as soon as it exists. A run that dies at phase 5
 * keeps phases 1-4 on disk, so the tokens already paid for stay recoverable
 * instead of vanishing with the in-memory graph state.
 */
export async function recordPhaseOutput(
  runId: string,
  phase: string,
  payload: unknown,
): Promise<void> {
  const relativePath = `runs/${runId}/phases/${phase}.json`
  const key = `${runId}/${relativePath}`
  const content = JSON.stringify(payload, null, 2)
  const write = (phaseWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await putRunArtifactContent({
      runId,
      kind: `phase:${phase}`,
      relativePath,
      mimeType: 'application/json',
      content,
    })
  })
  phaseWrites.set(key, write)
  try {
    await write
  } catch (err) {
    throw new CheckpointWriteError(
      `Failed to record checkpoint ${phase}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  } finally {
    if (phaseWrites.get(key) === write) phaseWrites.delete(key)
  }
}

/** Phases whose output can seed a later run, keyed by graph node name. */
export type PhaseCheckpoints = {
  architecture: ArchitectureData | null
  strideThreats: RawThreat[] | null
  pastaThreats: RawThreat[] | null
  attackTreeThreats: RawThreat[] | null
  preDedup: { threatsKept: RawThreat[]; filteredCount: number } | null
  debateRounds: DebateRound[] | null
  debateComplete: boolean
  threatsPreDedup: UnifiedThreat[] | null
  dread: { threatsFinal: UnifiedThreat[]; filteredCount: number } | null
  /** A normal payload can coexist with this marker when a fallback produced it. */
  degradedPhases: string[]
}

export function resumableCheckpointPhases(checkpoints: PhaseCheckpoints): string[] {
  const phases: string[] = []
  const usable = (phase: string) => !checkpoints.degradedPhases.includes(phase)
  if (checkpoints.architecture && usable('architecture_parser')) phases.push('architecture_parser')
  if (checkpoints.strideThreats && usable('stride_analyst') && hasAnalystDelivery(checkpoints.architecture, 'stride')) phases.push('stride_analyst')
  if (checkpoints.pastaThreats && usable('pasta_analyst') && hasAnalystDelivery(checkpoints.architecture, 'pasta')) phases.push('pasta_analyst')
  if (checkpoints.attackTreeThreats && usable('attack_tree_analyst') && hasAnalystDelivery(checkpoints.architecture, 'attack_tree')) phases.push('attack_tree_analyst')

  // Downstream work is only reusable when every dependency was checkpointed.
  // Otherwise a retried analyst could produce new candidates while stale
  // dedup/debate output incorrectly bypasses them.
  const analystsComplete =
    ['architecture_parser', 'stride_analyst', 'pasta_analyst', 'attack_tree_analyst'].every(phase => phases.includes(phase))
  if (!analystsComplete || !checkpoints.preDedup || !usable('pre_dedup')) return phases

  phases.push('pre_dedup')
  if (!checkpoints.debateRounds || !checkpoints.debateComplete || !usable('debate')) return phases
  phases.push('debate')
  if (!checkpoints.threatsPreDedup || !usable('threat_synthesizer')) return phases
  phases.push('threat_synthesizer')
  if (checkpoints.dread && usable('dread_validator')) phases.push('dread_validator')
  return phases
}

async function readVerifiedFinalArtifact(runId: string, kind: string): Promise<string | null> {
  return getRunArtifactText(runId, kind)
}

/** Restore only checksummed evidence checkpoints from the authorized source run. */
export async function readRAGEvidenceCheckpoints(runId: string, phases: string[]): Promise<RAGTraceSnapshot[]> {
  const snapshots: RAGTraceSnapshot[] = []
  for (const kind of ['rag-trace', ...phases.map(phase => `phase:rag_evidence_${phase}`)]) {
    const content = await readVerifiedFinalArtifact(runId, kind)
    if (!content) continue
    const parsed = JSON.parse(content) as RAGTraceSnapshot
    if (parsed.version === 2 && Array.isArray(parsed.entries)) snapshots.push(parsed)
  }
  return snapshots
}

/**
 * Completed local runs keep an immutable, checksummed findings snapshot. It is
 * also the recovery source for runs whose relational threat rows are missing.
 */
export async function readFinalThreatsArtifact(runId: string): Promise<UnifiedThreat[] | null> {
  const content = await readVerifiedFinalArtifact(runId, 'threats')
  if (!content) return null
  const parsed = JSON.parse(content) as unknown
  if (!Array.isArray(parsed)) throw new Error('Final threats artifact is not an array')
  return parsed as UnifiedThreat[]
}

export async function readFinalReportArtifact(runId: string): Promise<string | null> {
  return readVerifiedFinalArtifact(runId, 'report')
}

const RESUMABLE_PHASES = ['stride_analyst', 'pasta_analyst', 'attack_tree_analyst'] as const
type AnalystCheckpoint = RawThreat[] | { threats: RawThreat[]; sourceDelivery?: string[] }

/**
 * Reads what a previous run already paid for. A resumed run reuses these phases
 * instead of regenerating them: the analysts are the most expensive part of the
 * pipeline, and a run that died in debate has already banked all of them.
 */
export async function readPhaseCheckpoints(runId: string): Promise<PhaseCheckpoints> {
  async function readPhase<T>(phase: string): Promise<T | null> {
    try {
      const content = await getRunArtifactText(runId, `phase:${phase}`)
      if (!content) return null
      return JSON.parse(content) as T
    } catch (error) {
      throw new CheckpointWriteError(
        `Checkpoint ${phase} is corrupt: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  const phaseNames = [
    'architecture_parser', 'stride_analyst', 'pasta_analyst', 'attack_tree_analyst',
    'pre_dedup', 'debate', 'threat_synthesizer', 'dread_validator',
  ] as const
  const [architecture, stride, pasta, attackTree, preDedup, debateRounds, threatsPreDedup, dread, degraded, finalArchitectureText] =
    await Promise.all([
      readPhase<ArchitectureData>('architecture_parser'),
      readPhase<AnalystCheckpoint>(RESUMABLE_PHASES[0]),
      readPhase<AnalystCheckpoint>(RESUMABLE_PHASES[1]),
      readPhase<AnalystCheckpoint>(RESUMABLE_PHASES[2]),
      readPhase<{ threatsKept: RawThreat[]; filteredCount: number }>('pre_dedup'),
      readPhase<DebateRound[] | { rounds: DebateRound[]; complete: boolean }>('debate'),
      readPhase<UnifiedThreat[]>('threat_synthesizer'),
      readPhase<{ threatsFinal: UnifiedThreat[]; filteredCount: number }>('dread_validator'),
      Promise.all(phaseNames.map(async (phase) =>
        (await getRunArtifact(runId, `phase:${phase}.degraded`)) ? phase : null,
      )),
      readVerifiedFinalArtifact(runId, 'architecture'),
    ] as const)

  // Older completed/partial runs stored delivery on the final architecture,
  // while their earlier architecture checkpoint still lacked it. Reuse that
  // checksummed proof only for the exact same immutable source sections.
  const finalArchitecture = finalArchitectureText ? JSON.parse(finalArchitectureText) as ArchitectureData | null : null
  if (architecture?.sourceEvidence && finalArchitecture?.sourceEvidence
    && sha256Hex(JSON.stringify(architecture.sourceEvidence.sections)) === sha256Hex(JSON.stringify(finalArchitecture.sourceEvidence.sections))) {
    architecture.sourceEvidence.analystDelivery = {
      ...architecture.sourceEvidence.analystDelivery,
      ...finalArchitecture.sourceEvidence.analystDelivery,
    }
  }

  const normalizedDebate = Array.isArray(debateRounds)
    ? { rounds: debateRounds, complete: true }
    : debateRounds ?? { rounds: null, complete: false }
  // Old versions applied this safeguard per batch. A partially guarded round
  // depends on batch boundaries and must be reviewed again under the new policy.
  const hasBatchDependentDebate = normalizedDebate.rounds?.some(round => {
    const guarded = round.threatAssessments.filter(assessment =>
      assessment.notes?.startsWith('Safeguard: blanket invalidation was treated as an inconsistent model response.'))
    return guarded.length > 0 && guarded.length < round.threatAssessments.length
  }) ?? false

  // Keep completion evidence in the same atomic artifact as the findings.
  // Older array checkpoints remain readable, but cannot invent source coverage.
  function restoreAnalyst(payload: AnalystCheckpoint | null, analyst: string): RawThreat[] | null {
    if (!payload || Array.isArray(payload)) return payload
    if (architecture?.sourceEvidence && Array.isArray(payload.sourceDelivery)
      && payload.sourceDelivery.every(id => typeof id === 'string')) {
      architecture.sourceEvidence.analystDelivery ??= {}
      architecture.sourceEvidence.analystDelivery[analyst] = payload.sourceDelivery
    }
    return payload.threats
  }

  return {
    architecture,
    strideThreats: restoreAnalyst(stride, 'stride'),
    pastaThreats: restoreAnalyst(pasta, 'pasta'),
    attackTreeThreats: restoreAnalyst(attackTree, 'attack_tree'),
    preDedup: preDedup ?? null,
    debateRounds: hasBatchDependentDebate ? null : normalizedDebate.rounds,
    debateComplete: !hasBatchDependentDebate && normalizedDebate.complete,
    threatsPreDedup: threatsPreDedup ?? null,
    dread: dread ?? null,
    degradedPhases: degraded.filter((phase): phase is (typeof phaseNames)[number] => phase !== null),
  }
}

export async function finalizeRunArtifacts(
  runId: string,
  architecture: unknown,
  threats: unknown[],
  summary: Record<string, unknown>,
  ragTrace?: RAGTraceSnapshot,
  status: 'completed' | 'partial' = 'completed',
  debateSummary = '',
): Promise<void> {
  try {
    await putRunArtifactContent({
      runId,
      kind: 'architecture',
      relativePath: `runs/${runId}/architecture.json`,
      mimeType: 'application/json',
      content: JSON.stringify(architecture ?? null, null, 2),
    })
    await putRunArtifactContent({
      runId,
      kind: 'threats',
      relativePath: `runs/${runId}/threats.json`,
      mimeType: 'application/json',
      content: JSON.stringify(threats, null, 2),
    })
    if (ragTrace) {
      await putRunArtifactContent({
        runId,
        kind: 'rag-trace',
        relativePath: `runs/${runId}/rag-trace.json`,
        mimeType: 'application/json',
        content: JSON.stringify(ragTrace, null, 2),
      })
    }
    const qualityReport = evaluateThreatQuality(
      architecture as ArchitectureData | null,
      threats as UnifiedThreat[],
      debateSummary,
    )
    await putRunArtifactContent({
      runId,
      kind: 'quality',
      relativePath: `runs/${runId}/quality.json`,
      mimeType: 'application/json',
      content: JSON.stringify(qualityReport, null, 2),
    })

    await writeManifest(runId, {
      status,
      finishedAt: new Date().toISOString(),
      summary,
    })
    try {
      await writeRunReportArtifact(runId)
    } catch (err) {
      logger.warn('Failed to generate markdown report artifact', {
        analysisId: runId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } catch (err) {
    throw new CheckpointWriteError(
      `Failed to finalize run artifacts: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

export async function writeRunReportArtifact(runId: string): Promise<void> {
  const threatModel = await getThreatModel(runId)
  if (!threatModel) return
  const threatRows = await listThreats(runId)
  const markdown = generateMarkdownFromDB({ threatModel, threats: threatRows })
  await putRunArtifactContent({
    runId,
    kind: 'report',
    relativePath: `runs/${runId}/report.md`,
    mimeType: 'text/markdown',
    content: markdown,
  })
}

export async function failRunArtifacts(runId: string, message: string): Promise<void> {
  try {
    await writeManifest(runId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: message,
    })
  } catch (err) {
    throw new CheckpointWriteError(
      `Failed to record run failure artifact: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}
