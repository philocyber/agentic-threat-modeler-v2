import { architectureForFindings } from '@/lib/architecture/source-evidence'
import { buildArchSummary } from './shared'
import type { ArchitectureData, DebateCandidate, DebateRound } from '@/lib/models/types'

function formatEvidence(threat: DebateCandidate): string {
  const sources = threat.evidenceSources
  if (sources.length === 0) return 'none'
  return sources
    .map((source) => `${source.sourceType}:${source.sourceName}: ${source.excerpt}`)
    .join(' | ')
}

function formatTraceability(threat: DebateCandidate): string {
  const trace = threat.traceability
  if (!trace) return 'none'
  const parts = [
    trace.components?.length ? `components=${trace.components.join(',')}` : '',
    trace.endpoints?.length ? `endpoints=${trace.endpoints.join(',')}` : '',
    trace.trustBoundaries?.length ? `boundaries=${trace.trustBoundaries.join(',')}` : '',
    trace.securityConfigs?.length ? `configs=${trace.securityConfigs.join(',')}` : '',
  ].filter(Boolean)
  return parts.join('; ') || 'none'
}

export function formatDebateFinding(threat: DebateCandidate): string {
  const lines = [
    `${threat.draftId}. [${threat.methodology}] component=${threat.component}; confidence=${threat.confidenceScore}`,
    `description=${threat.description}`,
    `impact=${threat.impact}`,
    `mitigation=${threat.mitigation}`,
    `evidence=${formatEvidence(threat)}`,
    `traceability=${formatTraceability(threat)}`,
  ]
  if (threat.controlReference) lines.splice(4, 0, `controlReference=${threat.controlReference}`)
  if (threat.reasoning) lines.push(`reasoning=${threat.reasoning}`)
  if (threat.attackerProfile) lines.push(`attackerProfile=${threat.attackerProfile}`)
  if (threat.attackVector) lines.push(`attackVector=${threat.attackVector}`)
  return lines.join('\n')
}

export function buildThreatsSummary(threats: DebateCandidate[]): string {
  return threats.map(formatDebateFinding).join('\n\n')
}

function formatPreviousFinding(
  assessment: DebateRound['threatAssessments'][number],
): string {
  const interim = assessment.interimSummary?.trim()
  const judge = assessment.judgeNotes?.trim()
  const lines = [
    assessment.draftId,
    `  Red: ${assessment.redNotes?.trim() ?? ''}`,
    `  Blue: ${assessment.blueNotes?.trim() ?? ''}`,
  ]
  if (assessment.redReplyNotes?.trim()) lines.push(`  Red reply: ${assessment.redReplyNotes.trim()}`)
  // Keep provisional narration visibly separate from a final adjudication so
  // the next pair can use its substance without treating it as a ruling.
  if (interim) lines.push(`  Interim summary: ${interim}`)
  if (judge) lines.push(`  Judge: ${judge}`)
  return lines.join('\n')
}

export function buildPreviousContext(previousRounds: DebateRound[]): string {
  if (previousRounds.length === 0) return ''
  const dialogue = previousRounds.map((round) =>
    `Round ${round.round}:\n${round.threatAssessments.map(formatPreviousFinding).join('\n')}`,
  ).join('\n\n')
  return `\n\nDIALOGUE SO FAR. Name the opponent's latest premise in your reply. Repeating your own previous notes is not a reply.\n${dialogue}`
}

export function buildDebateDossier(params: {
  architecture?: ArchitectureData | null | undefined
  model?: unknown
  threats: DebateCandidate[]
  previousRounds: DebateRound[]
}): string {
  const architecture = params.architecture
    ? `SYSTEM ARCHITECTURE:\n${buildArchSummary(architectureForFindings(params.architecture, params.threats, params.model))}\n\n`
    : ''
  return `${architecture}Threats under review:\n${buildThreatsSummary(params.threats)}${buildPreviousContext(params.previousRounds)}`
}

function boundQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, 500)
}

export function buildRedPrefetchQuery(threats: DebateCandidate[]): string {
  const parts = threats.slice(0, 8).map((threat) =>
    `${threat.component}: ${threat.description.slice(0, 120)}`,
  )
  return boundQuery(`Architecture risk patterns, necessary preconditions and evidence limitations for: ${parts.join('; ')}`)
}

export function buildBluePrefetchQuery(
  threats: DebateCandidate[],
  architecture?: ArchitectureData | null,
): string {
  const components = [...new Set(threats.map((threat) => threat.component))].slice(0, 8)
  const controls = (architecture?.factLedger?.controls ?? [])
    .filter((control) => control.status === 'enabled' || control.status === 'disabled')
    .slice(0, 8)
    .map((control) => `${control.name}:${control.status}`)
  const controlClause = controls.length ? `; documented controls: ${controls.join(', ')}` : ''
  return boundQuery(
    `Blue team controls, mitigations, and architecture constraints for components ${components.join(', ')}${controlClause}`,
  )
}

export function buildReplyPrefetchQuery(threats: DebateCandidate[]): string {
  const parts = threats.slice(0, 8).map((threat) =>
    `${threat.draftId} ${threat.component}: ${threat.description.slice(0, 80)}`,
  )
  return boundQuery(`Coverage and limitations of documented defensive controls for: ${parts.join('; ')}`)
}

export function formatSideAssessments(
  assessments: Array<{ draftId: string; verdict: string; disposition?: string | undefined; notes: string }>,
  includeLabels = true,
): string {
  return assessments
    .map((assessment) => {
      if (!includeLabels) return `${assessment.draftId}: ${assessment.notes}`
      const disposition = assessment.disposition ? `; disposition=${assessment.disposition}` : ''
      return `${assessment.draftId}: ${assessment.verdict}${disposition}; ${assessment.notes}`
    })
    .join('\n')
}
