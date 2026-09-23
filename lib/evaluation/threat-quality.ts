import { lexicalSimilarity } from '@/lib/embeddings/client'
import type { ArchitectureData, UnifiedThreat } from '@/lib/models/types'
import { normalizeThreatScore } from '@/lib/models/scoring'
import { parseStoredDebateRounds } from '@/lib/agents/debate-format'

export type ThreatQualityReport = {
  threatCount: number
  duplicatePairs: Array<{ left: string; right: string; similarity: number }>
  duplicateRate: number
  componentCoverage: number
  coveredComponents: string[]
  uncoveredComponents: string[]
  methodologiesRepresented: string[]
  dispositionCounts: Record<string, number>
  possibleControlContradictions: string[]
  evidenceIntegrity: {
    architectureAnchors: { verified: number; unverified: number; unlinked: number }
    ragReferences: { verified: number; unverified: number; unlinked: number }
    unverifiedFindingIds: string[]
    unlinkedFindingIds: string[]
  }
  incompleteMitigationIds: string[]
  unscoredFindingIds: string[]
  unresolvedDebateFindingIds: string[]
  passed: boolean
}

function citationBucket(sources: UnifiedThreat['evidenceSources']): { verified: number; unverified: number; unlinked: number } {
  return {
    verified: sources.filter((source) => source.referenceStatus === 'verified').length,
    unverified: sources.filter((source) => source.referenceStatus === 'unverified').length,
    unlinked: sources.filter((source) => source.supportStatus === 'unlinked').length,
  }
}

function fingerprint(threat: UnifiedThreat): string {
  return `${threat.component} ${threat.title ?? ''} ${threat.description}`
    .toLowerCase()
    .replace(/\b(?:recurring|duplicate|revised)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
}

export function evaluateThreatQuality(
  architecture: ArchitectureData | null | undefined,
  threats: UnifiedThreat[],
  debateSummary = '',
): ThreatQualityReport {
  const duplicatePairs: ThreatQualityReport['duplicatePairs'] = []
  for (let left = 0; left < threats.length; left += 1) {
    for (let right = left + 1; right < threats.length; right += 1) {
      const leftThreat = threats[left]
      const rightThreat = threats[right]
      if (!leftThreat || !rightThreat) continue
      const similarity = lexicalSimilarity(fingerprint(leftThreat), fingerprint(rightThreat))
      if (similarity >= 0.68) duplicatePairs.push({ left: leftThreat.id, right: rightThreat.id, similarity })
    }
  }

  const components = architecture?.components.map((component) => component.name) ?? []
  const coveredComponents = components.filter((component) => threats.some((threat) =>
    `${threat.component} ${(threat.traceability?.components ?? []).join(' ')}`.toLowerCase().includes(component.toLowerCase()),
  ))
  const uncoveredComponents = components.filter((component) => !coveredComponents.includes(component))
  const methodologiesRepresented = [...new Set(threats.flatMap((threat) => threat.methodologies ?? [threat.methodology]))]
  const dispositionCounts = threats.reduce<Record<string, number>>((counts, threat) => {
    const disposition = threat.disposition ?? 'unspecified'
    counts[disposition] = (counts[disposition] ?? 0) + 1
    return counts
  }, {})
  const enabledControls = (architecture?.factLedger?.controls ?? []).filter((control) => control.status === 'enabled')
  const possibleControlContradictions = threats.filter((threat) => {
    if (threat.disposition === 'control_verification_needed' || threat.disposition === 'conditional') return false
    const text = `${threat.title ?? ''} ${threat.description}`
    return enabledControls.some((control) => {
      if (/parameterized/i.test(control.name)) return /unparameterized|no parameterization|missing parameterization/i.test(text)
      if (/jwt validation/i.test(control.name)) return /missing jwt validation|jwt validation disabled|without jwt validation/i.test(text)
      if (/rate limiting/i.test(control.name)) return /no rate limit|missing rate limit|without rate limit/i.test(text)
      if (/tls/i.test(control.name)) return /no tls|without tls|plaintext transport/i.test(text)
      return false
    })
  }).map((threat) => threat.id)

  const duplicateRate = threats.length > 0 ? duplicatePairs.length / threats.length : 0
  const componentCoverage = components.length > 0 ? coveredComponents.length / components.length : 1
  const ragSources = threats.flatMap(threat => (threat.evidenceSources ?? []).filter(source => source.sourceType === 'rag'))
  const architectureSources = threats.flatMap(threat => (threat.evidenceSources ?? []).filter(source => source.sourceType === 'architecture'))
  const unverifiedFindingIds = threats.filter(threat => (threat.evidenceSources ?? []).some(source =>
    (source.sourceType === 'architecture' || source.sourceType === 'rag')
    && source.referenceStatus === 'unverified')).map(threat => threat.id)
  // Auxiliary or contradictory passages may remain visibly unlinked. A finding
  // fails this gate only when none of its verified references supports it.
  const unlinkedFindingIds = threats.filter(threat => !(threat.evidenceSources ?? []).some(source =>
    source.referenceStatus === 'verified' && source.supportStatus === 'supports')).map(threat => threat.id)
  const incompleteMitigationIds = threats.filter(threat => !(threat.mitigation ?? '').trim() || /(?:\.\.\.|…)\s*$/.test(threat.mitigation)).map(threat => threat.id)
  const unscoredFindingIds = threats.filter(threat => normalizeThreatScore(threat).scoringStatus === 'unscored').map(threat => threat.id)
  const latestDebate = new Map(parseStoredDebateRounds(debateSummary, threats).flatMap(round => round.findings.map(item => [item.id, item] as const)))
  const unresolvedDebateFindingIds = [...latestDebate.values()].filter(item => item.qualityIssues?.length).map(item => item.id)
  return {
    threatCount: threats.length,
    duplicatePairs,
    duplicateRate,
    componentCoverage,
    coveredComponents,
    uncoveredComponents,
    methodologiesRepresented,
    dispositionCounts,
    possibleControlContradictions,
    evidenceIntegrity: {
      architectureAnchors: citationBucket(architectureSources),
      ragReferences: citationBucket(ragSources),
      unverifiedFindingIds,
      unlinkedFindingIds,
    },
    incompleteMitigationIds,
    unscoredFindingIds,
    unresolvedDebateFindingIds,
    passed: duplicatePairs.length === 0 && possibleControlContradictions.length === 0 && componentCoverage >= 0.6 && !unverifiedFindingIds.length && !unlinkedFindingIds.length && !incompleteMitigationIds.length && !unscoredFindingIds.length && !unresolvedDebateFindingIds.length,
  }
}
