import { isDebateFindingResolved } from './debate-convergence'
import { writtenFindingConclusion } from './debate-quality'
import type { DebateCandidate, DebateRound } from '@/lib/models/types'

export const DEBATE_BATCH_SIZE = 3
export const DEFAULT_DEBATE_BATCH_CONCURRENCY = 3

export function chunkDebateBatches<T>(
  items: readonly T[],
  size: number = DEBATE_BATCH_SIZE,
): T[][] {
  const batchSize = Math.max(1, size)
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize) as T[])
  }
  return batches
}

export function previousRoundsForBatch(
  previousRounds: DebateRound[],
  threats: DebateCandidate[],
): DebateRound[] {
  const ids = new Set(threats.map((threat) => threat.draftId))
  return previousRounds
    .map((round) => ({
      ...round,
      threatAssessments: round.threatAssessments.filter((assessment) => ids.has(assessment.draftId)),
    }))
    .filter((round) => round.threatAssessments.length > 0)
}

export function unresolvedDebateCandidates(
  candidates: DebateCandidate[],
  round: DebateRound,
): DebateCandidate[] {
  const byId = new Map(round.threatAssessments.map((assessment) => [assessment.draftId, assessment]))
  return candidates.filter((candidate) => {
    const assessment = byId.get(candidate.draftId)
    return !assessment || !isDebateFindingResolved(assessment)
  })
}

/**
 * Cursor `replayAgreedFindings: false` uses team agreement, not judgeNotes.
 * isDebateFindingResolved() would keep every provisional Cursor card in play
 * because that profile has no interim judge.
 */
export function candidatesNeedingReplay(
  candidates: DebateCandidate[],
  round: DebateRound,
): DebateCandidate[] {
  const byId = new Map(round.threatAssessments.map((assessment) => [assessment.draftId, assessment]))
  return candidates.filter((candidate) => {
    const assessment = byId.get(candidate.draftId)
    if (!assessment) return true
    if (assessment.qualityIssues?.length) return true
    if (assessment.consensus !== 'agreed') return true
    return assessment.finalVerdict === 'unresolved'
  })
}

function closeCarriedAssessment(
  assessment: DebateRound['threatAssessments'][number],
  isFinalRound: boolean,
): DebateRound['threatAssessments'][number] {
  if (!isFinalRound || assessment.judgeNotes || assessment.consensus !== 'agreed' || assessment.qualityIssues?.length) {
    return assessment
  }
  const close = writtenFindingConclusion(assessment.blueNotes)
  if (!close) return assessment
  const judgeNotes = `Team conclusion (agreed): ${close}`
  return {
    ...assessment,
    judgeNotes,
    notes: `Conclusion: ${judgeNotes} | Red: ${assessment.redNotes ?? 'no assessment'} | Blue: ${assessment.blueNotes ?? 'no assessment'}`,
  }
}

/** Merge a later-round live batch with carried agreement, preserving draft order. */
export function mergeReplayedDebateRound(params: {
  roundNumber: number
  isFinalRound: boolean
  orderedDraftIds: string[]
  previous: DebateRound
  live?: DebateRound
}): DebateRound {
  const liveById = new Map((params.live?.threatAssessments ?? []).map((assessment) => [assessment.draftId, assessment]))
  const previousById = new Map(params.previous.threatAssessments.map((assessment) => [assessment.draftId, assessment]))
  const threatAssessments = params.orderedDraftIds.flatMap((draftId) => {
    const live = liveById.get(draftId)
    if (live) return [live]
    const previous = previousById.get(draftId)
    return previous ? [closeCarriedAssessment(previous, params.isFinalRound)] : []
  })
  const live = params.live
  return {
    round: params.roundNumber,
    isFinalRound: params.isFinalRound,
    redTeamArguments: live?.redTeamArguments ?? '',
    blueTeamArguments: live?.blueTeamArguments ?? '',
    convergenceSignal: threatAssessments.length > 0
      && threatAssessments.every((item) => item.consensus === 'agreed' && !item.qualityIssues?.length),
    threatAssessments,
    ...(live?.judgeSummary ? { judgeSummary: live.judgeSummary, judgeConverged: live.judgeConverged } : {}),
  }
}

export function mergeDebateBatchRounds(
  roundNumber: number,
  batches: DebateRound[],
  orderedDraftIds: string[],
): DebateRound {
  const byId = new Map<string, DebateRound['threatAssessments'][number]>()
  for (const batch of batches) {
    for (const assessment of batch.threatAssessments) byId.set(assessment.draftId, assessment)
  }
  const judgeSummaries = batches
    .map((batch) => batch.judgeSummary)
    .filter((summary): summary is string => Boolean(summary))
  return {
    round: roundNumber,
    isFinalRound: batches.every(batch => batch.isFinalRound !== false),
    redTeamArguments: batches.map((batch) => batch.redTeamArguments).filter(Boolean).join('\n\n'),
    blueTeamArguments: batches.map((batch) => batch.blueTeamArguments).filter(Boolean).join('\n\n'),
    convergenceSignal: batches.length > 0 && batches.every((batch) => batch.convergenceSignal),
    threatAssessments: orderedDraftIds.flatMap((draftId) => {
      const assessment = byId.get(draftId)
      return assessment ? [assessment] : []
    }),
    ...(judgeSummaries.length
      ? {
          judgeSummary: judgeSummaries.join('\n\n'),
          judgeConverged: batches.every((batch) => batch.judgeConverged !== false),
        }
      : {}),
  }
}
