import type { DebateRound } from '@/lib/models/types'
import { debateAssessmentIssues, latestDebateAssessments, writtenFindingConclusion } from './debate-quality'

/**
 * Stable fingerprint of per-threat final verdicts for a debate round.
 * Describes outcome stability; it does not shorten the configured dialogue.
 */
export function debateVerdictFingerprint(
  assessments: DebateRound['threatAssessments'],
): string {
  return assessments
    .map((a) => {
      return `${a.draftId}:${a.finalVerdict}:${a.disposition ?? ''}`
    })
    .sort()
    .join('|')
}

/**
 * `judgeNotes` is not by itself proof of a ruling: under
 * `profile.interimConclusions` a provisional round carries a close from
 * DebateInterimJudge, which deliberately assigns no labels. Anything using this
 * to skip work must also require the round to be final, or a finding drops out
 * of later rounds on the strength of commentary. `candidatesNeedingReplay` in
 * debate-batches.ts keys on team agreement for exactly that reason.
 */
export function isDebateFindingResolved(
  assessment: DebateRound['threatAssessments'][number],
): boolean {
  if (debateAssessmentIssues(assessment).length) return false
  return Boolean(writtenFindingConclusion(assessment.judgeNotes))
}

/** Consensus belongs to the teams, not the judge or a model's stop signal. */
export function hasDebateConverged(rounds: DebateRound[]): boolean {
  const latest = rounds[rounds.length - 1]
  if (!latest || latest.isFinalRound === false) return false
  const assessments = latestDebateAssessments(rounds)
  return assessments.length > 0 && assessments.every(assessment =>
    !debateAssessmentIssues(assessment).length
    && (assessment.consensus ? assessment.consensus === 'agreed' :
      (assessment.redReplyVerdict ?? assessment.redVerdict) === assessment.blueVerdict
      && (assessment.redReplyDisposition ?? assessment.redDisposition) === assessment.blueDisposition))
}
