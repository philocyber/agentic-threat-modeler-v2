/**
 * Context the DREAD validator needs to score honestly.
 *
 * The validator used to receive nothing but a threat title and 250 characters
 * of description, while its prompt demanded it apply "reductions for documented
 * controls" and assume anything unmentioned is absent. With the controls
 * structurally hidden from it, that instruction could only inflate. This module
 * assembles what the rest of the pipeline already knows — the deterministic
 * fact ledger and the debate ruling — into the batch it sees.
 */

import type { ArchitectureData, DebateRound, UnifiedThreat } from '@/lib/models/types'

type LedgerControl = NonNullable<ArchitectureData['factLedger']>['controls'][number]
type Assessment = DebateRound['threatAssessments'][number]

export type DebateVerdictInfo = {
  draftId: string
  finalVerdict: Assessment['finalVerdict']
  disposition?: Assessment['disposition']
  redNotes?: string | undefined
  blueNotes?: string | undefined
  judgeNotes?: string | undefined
}

export type ValidatorContext = {
  architecture?: ArchitectureData | null | undefined
  unknownControls?: LedgerControl[]

  enabledControls: LedgerControl[]
  disabledControls: LedgerControl[]
  /** Keyed by the candidate id carried on synthesized threats. */
  verdictByCandidateId: Map<string, DebateVerdictInfo>
}

export const EMPTY_VALIDATOR_CONTEXT: ValidatorContext = {
  enabledControls: [],
  disabledControls: [],
  verdictByCandidateId: new Map(),
}

function clip(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

export function buildValidatorContext(params: {
  architecture?: ArchitectureData | null | undefined
  debateRounds?: DebateRound[] | undefined
  /** DRAFT-n → candidateId, as assigned when the debate cases were built. */
  candidateIdByDraftId?: Map<string, string> | undefined
}): ValidatorContext {
  const controls = params.architecture?.factLedger?.controls ?? []
  const verdictByCandidateId = new Map<string, DebateVerdictInfo>()

  // Later rounds supersede earlier ones for the same draft.
  for (const round of params.debateRounds ?? []) {
    for (const assessment of round.threatAssessments) {
      const candidateId = params.candidateIdByDraftId?.get(assessment.draftId)
      if (!candidateId) continue
      const info: DebateVerdictInfo = {
        draftId: assessment.draftId,
        finalVerdict: assessment.finalVerdict,
      }
      if (assessment.disposition) info.disposition = assessment.disposition
      const red = clip(assessment.redNotes, 180)
      if (red) info.redNotes = red
      const blue = clip(assessment.blueNotes ?? assessment.notes, 220)
      if (blue) info.blueNotes = blue
      const judge = clip(assessment.judgeNotes, 220)
      if (judge) info.judgeNotes = judge
      verdictByCandidateId.set(candidateId, info)
    }
  }

  return {
    architecture: params.architecture,
    unknownControls: controls.filter(control => control.status === 'unknown'),
    enabledControls: controls.filter((control) => control.status === 'enabled'),
    disabledControls: controls.filter((control) => control.status === 'disabled'),
    verdictByCandidateId,
  }
}

/** Shared header for a batch: the controls the ceiling rules refer to. */
export function formatControlsBlock(context: ValidatorContext): string {
  if (context.enabledControls.length === 0 && context.disabledControls.length === 0 && !context.unknownControls?.length) {
    return 'DOCUMENTED CONTROLS: none were extracted from the architecture. Control coverage is unknown; do not infer absence.'
  }
  const lines: string[] = ['DOCUMENTED CONTROLS (deterministic fact ledger — apply the ceiling rules):']
  for (const control of context.enabledControls) {
    lines.push(
      `- [enabled] ${control.name}${control.component ? ` @ ${control.component}` : ''}: ${control.evidence ?? '(no excerpt)'}`,
    )
  }
  for (const control of context.disabledControls) {
    lines.push(
      `- [disabled/missing] ${control.name}${control.component ? ` @ ${control.component}` : ''}: ${control.evidence ?? '(no excerpt)'}`,
    )
  }
  for (const control of context.unknownControls ?? []) lines.push(`- [unknown] ${control.name}: ${control.evidence}`)
  lines.push(
    'A control absent from this list has UNKNOWN coverage. Missing evidence never proves absence.',
  )
  return lines.join('\n')
}

export function verdictForThreat(
  threat: Pick<UnifiedThreat, 'sourceCandidateIds'>,
  context: ValidatorContext,
): DebateVerdictInfo | undefined {
  for (const candidateId of threat.sourceCandidateIds ?? []) {
    const verdict = context.verdictByCandidateId.get(candidateId)
    if (verdict) return verdict
  }
  return undefined
}

/**
 * One batch entry. The full description is included: it carries the named
 * endpoints and components the validator is asked to trace, and truncating it
 * at 250 characters was cutting exactly that away.
 */
export function formatValidatorThreat(threat: UnifiedThreat, context: ValidatorContext): string {
  const parts = [
    `ID: ${threat.id}`,
    `Component: ${threat.component}`,
    `Title: ${threat.title || '(not set)'}`,
    `Description: ${threat.description}`,
  ]

  if (threat.evidenceSources?.length) parts.push(`Original evidence references: ${JSON.stringify(threat.evidenceSources)}`)
  if (threat.strideCategory) parts.push(`STRIDE: ${threat.strideCategory}`)
  if (threat.owaspCategories?.length) parts.push(`OWASP: ${threat.owaspCategories.join(', ')}`)
  if (threat.controlReference) parts.push(`Control: ${threat.controlReference}`)
  const mitigation = threat.mitigation
  if (mitigation) parts.push(`Mitigation: ${mitigation}`)
  const impact = threat.impact
  if (impact) parts.push(`Impact: ${impact}`)
  if (threat.disposition) parts.push(`Disposition: ${threat.disposition}`)
  if (threat.preconditions?.length) {
    parts.push(`Preconditions: ${threat.preconditions.join(' | ')}`)
  }

  const verdict = verdictForThreat(threat, context)
  if (verdict) {
    const detail = [
      `final=${verdict.finalVerdict}`,
      verdict.disposition ? `disposition=${verdict.disposition}` : '',
      verdict.blueNotes ? `defense="${verdict.blueNotes}"` : '',
      verdict.judgeNotes ? `ruling="${verdict.judgeNotes}"` : '',
    ]
      .filter(Boolean)
      .join(' ')
    parts.push(`DEBATE (${verdict.draftId}): ${detail}`)
  }

  parts.push(
    `${threat.scoringStatus === 'unscored' ? 'UNSCORED: zero dimensions are storage placeholders, not assessed risk. Score independently. ' : ''}DREAD proposed by synthesis: D=${threat.dread.damage} R=${threat.dread.reproducibility} ` +
      `E=${threat.dread.exploitability} A=${threat.dread.affectedUsers} Disc=${threat.dread.discoverability} ` +
      `Total=${threat.dread.total}`,
  )

  return parts.join('\n')
}
