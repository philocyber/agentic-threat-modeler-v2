import type { DebateRound } from '@/lib/models/types'

type Assessment = DebateRound['threatAssessments'][number]

const PROCESS_STATUS_CONCLUSIONS = new Set([
  'The dialogue continues in the next configured round.',
  'Both teams reached the same applicability and severity assessment. Their reasoning is preserved above.',
  'No shared team position was established.',
])

/** Process-status copy is not a finding conclusion. */
export function writtenFindingConclusion(text?: string | null): string | undefined {
  const value = text?.trim()
  if (!value || PROCESS_STATUS_CONCLUSIONS.has(value)) return undefined
  return value
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/\b(?:red|blue) team\b/g, '')
    .match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Default 3-gram containment above which one turn is treated as a copy of the
 * other. Containment rather than a symmetric overlap, because the observed
 * failure is a team restating the opponent's paragraph and padding it with a
 * sentence of its own: that dilutes a symmetric score while leaving almost all
 * of the shorter turn inside the longer one.
 *
 * Per-provider override lives on DebateProfile.copyContainment (debate-profile.ts).
 * Kimi keeps 0.5 — hosted models copy less than the 9B; tightening here would
 * fire extra repair calls that Kimi's profile explicitly disables.
 * Ollama can raise this in its profile entry without editing this file.
 */
export const DEFAULT_COPY_CONTAINMENT = 0.5

function shingles(tokens: string[]): Set<string> {
  return new Set(tokens.slice(2).map((_, i) => tokens.slice(i, i + 3).join(' ')))
}

/** Detect copying, not agreement. Shared verdicts or short quotations are legitimate. */
export function duplicatedDebateRationale(red?: string, blue?: string, containment = DEFAULT_COPY_CONTAINMENT): boolean {
  if (!red?.trim() || !blue?.trim()) return false
  const left = words(red)
  const right = words(blue)
  if (left.join(' ') === right.join(' ')) return true
  if (Math.min(left.length, right.length) < 12) return false
  const a = shingles(left)
  const b = shingles(right)
  const smaller = Math.min(a.size, b.size)
  // Two short turns can share phrasing by coincidence; require enough material
  // for the ratio to mean anything.
  if (smaller < 20) return false
  const overlap = [...a].filter(value => b.has(value)).length
  return overlap / smaller >= containment
}

export function repeatedOwnTurn(current?: string, previous?: string, containment = DEFAULT_COPY_CONTAINMENT): boolean {
  return duplicatedDebateRationale(current, previous, containment)
}

export function debateAssessmentIssues(assessment: Pick<Assessment, 'redNotes' | 'blueNotes' | 'notes' | 'finalVerdict' | 'qualityIssues'>, provisional = false): string[] {
  const issues = [...(assessment.qualityIssues ?? [])]
  if (!assessment.redNotes?.trim() || !assessment.blueNotes?.trim()) issues.push('A separate rationale from each team is required.')
  if (duplicatedDebateRationale(assessment.redNotes, assessment.blueNotes)) issues.push('Red and Blue returned copied or nearly identical reasoning; independent review is unverified.')
  if (assessment.notes.includes('Safeguard: blanket invalidation')) issues.push('A legacy safeguard replaced rejected findings with medium severity without supporting adjudication.')
  if (!provisional && assessment.finalVerdict === 'unresolved' && !issues.length) issues.push('The debate has no resolved verdict.')
  return [...new Set(issues)]
}

export function latestDebateAssessments(rounds: DebateRound[]): Assessment[] {
  const latest = new Map<string, Assessment>()
  for (const round of rounds) for (const item of round.threatAssessments) latest.set(item.draftId, item)
  return [...latest.values()]
}
