import { generateThreatId } from '@/lib/db/helpers'
import { dreadToPriority } from '@/lib/models/scoring'
import type { RawThreat, UnifiedThreat } from '@/lib/models/types'

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:recurring|duplicate|revised|updated)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function merge(primary: UnifiedThreat, secondary: UnifiedThreat): UnifiedThreat {
  const evidence = [...new Map(
    [...primary.evidenceSources, ...secondary.evidenceSources]
      .map((source) => [`${source.sourceType}:${source.sourceName}:${source.excerpt}`, source]),
  ).values()]
  return {
    ...(secondary.confidenceScore > primary.confidenceScore ? secondary : primary),
    id: primary.id,
    methodologies: [...new Set([
      ...(primary.methodologies ?? [primary.methodology]),
      ...(secondary.methodologies ?? [secondary.methodology]),
    ])],
    sourceCandidateIds: [...new Set([
      ...(primary.sourceCandidateIds ?? []),
      ...(secondary.sourceCandidateIds ?? []),
    ])],
    evidenceSources: evidence,
    disposition: [primary, secondary].some(t => t.disposition === 'control_verification_needed') ? 'control_verification_needed'
      : [primary, secondary].some(t => t.disposition === 'conditional') ? 'conditional' : primary.disposition ?? secondary.disposition,
    preconditions: [...new Set([...(primary.preconditions ?? []), ...(secondary.preconditions ?? [])])],
    attackTree: primary.attackTree ?? secondary.attackTree,
    attackerProfile: primary.attackerProfile ?? secondary.attackerProfile,
    attackVector: primary.attackVector ?? secondary.attackVector,
  }
}

function overlaps(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left?.length || !right?.length) return false
  const normalizedRight = new Set(right.map(normalized))
  return left.some((value) => normalizedRight.has(normalized(value)))
}

function sharesStrongLineage(left: UnifiedThreat, right: UnifiedThreat): boolean {
  // A shared component, endpoint or boundary is not evidence of the same mechanism.
  return overlaps(left.sourceCandidateIds, right.sourceCandidateIds)
}

/**
 * Deterministic RawThreat → UnifiedThreat mapping with no LLM call. Used by the
 * reconciler and as the synthesis fallback: when the synthesizer fails, the run
 * still delivers the analyst findings instead of discarding them.
 */
export function rawToUnified(candidate: RawThreat): UnifiedThreat {
  const dread = { damage: 0, reproducibility: 0, exploitability: 0, affectedUsers: 0, discoverability: 0, total: 0 }
  return {
    id: generateThreatId(),
    component: candidate.component,
    strideCategory: candidate.strideCategory,
    methodology: candidate.methodology,
    methodologies: candidate.methodologies ?? [candidate.methodology],
    sourceCandidateIds: candidate.candidateId ? [candidate.candidateId] : [],
    disposition: candidate.disposition ?? 'conditional',
    preconditions: candidate.preconditions ?? ['Validate the architecture-specific exploit preconditions during analyst review.'],
    description: candidate.description,
    impact: candidate.impact,
    mitigation: candidate.mitigation,
    controlReference: candidate.controlReference,
    dread,
    scoringStatus: 'unscored',
    scoringRationale: 'Synthesis did not score this candidate. A successful scoring pass is required.',
    priority: dreadToPriority(dread.total),
    confidenceScore: candidate.confidenceScore,
    evidenceSources: candidate.evidenceSources,
    reasoning: candidate.reasoning,
    attackTree: candidate.attackTree,
    attackerProfile: candidate.attackerProfile,
    attackVector: candidate.attackVector,
    traceability: candidate.traceability,
  }
}

export function reconcileSynthesizedThreats(
  synthesized: UnifiedThreat[],
  candidates: RawThreat[],
  targetThreats: number,
): UnifiedThreat[] {
  const reconciled: UnifiedThreat[] = []
  for (const original of synthesized) {
    const explicitSourceIds = new Set(original.sourceCandidateIds ?? [])
    const sources = explicitSourceIds.size > 0
      ? candidates.filter((candidate) => candidate.candidateId && explicitSourceIds.has(candidate.candidateId))
      : []
    const threat: UnifiedThreat = {
      ...original,
      confidenceScore: sources.length ? Math.min(original.confidenceScore, Math.max(...sources.map(s => s.confidenceScore))) : original.confidenceScore,
      title: original.title?.replace(/\s*\((?:recurring|duplicate|revised)\)\s*$/i, '').trim(),
      methodologies: [...new Set<UnifiedThreat['methodology']>([
        ...sources.flatMap((source) => source.methodologies ?? [source.methodology]),
        original.methodology,
      ])],
      sourceCandidateIds: [...new Set([
        ...sources.flatMap((source) => source.candidateId ? [source.candidateId] : []),
      ])],
      disposition: sources.some(s => s.disposition === 'control_verification_needed') ? 'control_verification_needed'
        : sources.some(s => s.disposition === 'conditional') ? 'conditional' : original.disposition ?? 'conditional',
      preconditions: [...new Set([...(original.preconditions ?? []), ...sources.flatMap(s => s.preconditions ?? [])])],
      mitigation: /(?:\.\.\.|…)\s*$/.test(original.mitigation) && sources.some(s => !/(?:\.\.\.|…)\s*$/.test(s.mitigation))
        ? sources.filter(s => !/(?:\.\.\.|…)\s*$/.test(s.mitigation)).map(s => s.mitigation).join('\n') : original.mitigation,
      evidenceSources: [...new Map([...original.evidenceSources, ...sources.flatMap(s => s.evidenceSources)].map(source => [`${source.sourceType}:${source.sourceName}:${source.excerpt}`, source])).values()],
    }
    const duplicateIndex = reconciled.findIndex((existing) => sharesStrongLineage(existing, threat))
    if (duplicateIndex >= 0) {
      const existing = reconciled[duplicateIndex]
      if (existing) reconciled[duplicateIndex] = merge(existing, threat)
    } else {
      reconciled.push(threat)
    }
  }

  const maximum = Math.max(1, Math.min(targetThreats, 15))
  const desired = Math.min(maximum, candidates.length)
  const represented = new Set(reconciled.flatMap((threat) => threat.sourceCandidateIds ?? []))
  for (const candidate of candidates.slice().sort((a, b) => b.confidenceScore - a.confidenceScore)) {
    if (reconciled.length >= desired) break
    if (candidate.candidateId && represented.has(candidate.candidateId)) continue
    const fallback = rawToUnified(candidate)
    reconciled.push(fallback)
    if (candidate.candidateId) represented.add(candidate.candidateId)
  }

  return reconciled
    .sort((left, right) => right.confidenceScore - left.confidenceScore)
    .slice(0, maximum)
}
