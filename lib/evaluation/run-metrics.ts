/**
 * Deterministic quality metrics for one pipeline run.
 *
 * These exist because prompt changes are otherwise unfalsifiable: a rewritten
 * DREAD grid or a new coverage rule either moves these numbers or it did
 * nothing. Every metric here is computed from the run's own output — no model
 * call, no judgement — so two runs are comparable and a regression is visible.
 */

import { dreadToPriority, disagreesWithVerdict, type ThreatPriority } from '@/lib/models/scoring'
import { evaluateThreatQuality, type ThreatQualityReport } from '@/lib/evaluation/threat-quality'
import { verdictForThreat, type ValidatorContext } from '@/lib/agents/dread-context'
import type { AgentEvents, UsageTotals } from '@/lib/llm/usage'
import type { ArchitectureData, UnifiedThreat } from '@/lib/models/types'

const PRIORITIES: ThreatPriority[] = ['critical', 'high', 'medium', 'low']

const STRIDE_CATEGORIES = [
  'Spoofing',
  'Tampering',
  'Repudiation',
  'Information Disclosure',
  'Denial of Service',
  'Elevation of Privilege',
] as const

export type RunQualityMetrics = {
  threatCount: number
  priorityDistribution: Record<ThreatPriority, number>
  /** critical+high as a share of all threats. A run at 1.0 has stopped ranking. */
  highSeverityShare: number
  dread: {
    mean: number
    min: number
    max: number
    spread: number
    /** Distinct totals; 1 means every threat got the same score. */
    distinctTotals: number
  }
  stride: {
    distribution: Record<string, number>
    categoriesCovered: number
    /** Largest single-category share. High values mean one category swallowed the analysis. */
    maxShare: number
  }
  evidence: {
    withCitedSource: number
    withTraceability: number
    withNeither: number
    /** Share with a citation or an architecture anchor. */
    verifiableShare: number
  }
  debate: {
    assessed: number
    agreeing: number
    agreementShare: number
    /** True when no threat carrying an `invalid` ruling survived to the output. */
    invalidHonoured: boolean
  }
  dispositions: Record<string, number>
  quality: ThreatQualityReport
  degradation: {
    totals: AgentEvents
    byAgent: Record<string, AgentEvents>
  }
  tokens: {
    total: number
    input: number
    output: number
    byAgent: Record<string, number>
  }
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function hasCitedSource(threat: UnifiedThreat): boolean {
  return (threat.evidenceSources ?? []).some(
    (source) => Boolean(source.sourceName?.trim()) && Boolean(source.excerpt?.trim()),
  )
}

function hasTraceability(threat: UnifiedThreat): boolean {
  const trace = threat.traceability
  if (!trace) return false
  return (
    (trace.components?.length ?? 0) > 0 ||
    (trace.endpoints?.length ?? 0) > 0 ||
    (trace.trustBoundaries?.length ?? 0) > 0
  )
}

export function buildRunQualityMetrics(params: {
  architecture?: ArchitectureData | null | undefined
  threats: UnifiedThreat[]
  /** Debate rulings, keyed the same way the validator sees them. */
  validatorContext?: ValidatorContext | undefined
  usage?: UsageTotals | undefined
}): RunQualityMetrics {
  const threats = params.threats
  const count = threats.length

  const priorityDistribution = PRIORITIES.reduce<Record<ThreatPriority, number>>(
    (acc, priority) => {
      acc[priority] = threats.filter(
        (threat) => threat.scoringStatus !== 'unscored' && (threat.priority ?? dreadToPriority(threat.dread.total)) === priority,
      ).length
      return acc
    },
    { critical: 0, high: 0, medium: 0, low: 0 },
  )

  const totals = threats.filter(threat => threat.scoringStatus !== 'unscored').map((threat) => threat.dread.total)
  const dread = {
    mean: totals.length ? round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0,
    min: totals.length ? round(Math.min(...totals)) : 0,
    max: totals.length ? round(Math.max(...totals)) : 0,
    spread: totals.length ? round(Math.max(...totals) - Math.min(...totals)) : 0,
    distinctTotals: new Set(totals.map((total) => total.toFixed(1))).size,
  }

  const distribution: Record<string, number> = {}
  for (const category of STRIDE_CATEGORIES) distribution[category] = 0
  for (const threat of threats) {
    const category = threat.strideCategory?.trim()
    if (!category) continue
    distribution[category] = (distribution[category] ?? 0) + 1
  }
  const categorized = Object.values(distribution).reduce((a, b) => a + b, 0)
  const maxCategory = Math.max(0, ...Object.values(distribution))

  const withCitedSource = threats.filter(hasCitedSource).length
  const withTraceability = threats.filter(hasTraceability).length
  const withNeither = threats.filter(
    (threat) => !hasCitedSource(threat) && !hasTraceability(threat),
  ).length

  let assessed = 0
  let agreeing = 0
  let invalidSurvivors = 0
  if (params.validatorContext) {
    for (const threat of threats) {
      const verdict = verdictForThreat(threat, params.validatorContext)
      if (!verdict) continue
      assessed += 1
      if (verdict.finalVerdict === 'invalid' || verdict.disposition === 'invalid') {
        invalidSurvivors += 1
        continue
      }
      if (verdict.finalVerdict !== 'unresolved' && !disagreesWithVerdict(threat.dread.total, verdict.finalVerdict)) agreeing += 1
    }
  }

  const dispositions = threats.reduce<Record<string, number>>((acc, threat) => {
    const key = threat.disposition ?? 'unspecified'
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})

  const events = Object.values(params.usage?.agentEvents ?? {})
  const degradationTotals: AgentEvents = {
    bestEffortParses: events.reduce((sum, e) => sum + e.bestEffortParses, 0),
    validationRetries: events.reduce((sum, e) => sum + e.validationRetries, 0),
    transportRetries: events.reduce((sum, e) => sum + e.transportRetries, 0),
  }

  const byAgentTokens = Object.fromEntries(
    Object.entries(params.usage?.byAgent ?? {}).map(([agent, usage]) => [
      agent,
      usage.inputTokens + usage.outputTokens,
    ]),
  )

  return {
    threatCount: count,
    priorityDistribution,
    highSeverityShare: ratio(priorityDistribution.critical + priorityDistribution.high, count),
    dread,
    stride: {
      distribution,
      categoriesCovered: Object.values(distribution).filter((value) => value > 0).length,
      maxShare: ratio(maxCategory, categorized),
    },
    evidence: {
      withCitedSource,
      withTraceability,
      withNeither,
      verifiableShare: ratio(count - withNeither, count),
    },
    debate: {
      assessed,
      agreeing,
      agreementShare: ratio(agreeing, Math.max(0, assessed - invalidSurvivors)),
      invalidHonoured: invalidSurvivors === 0,
    },
    dispositions,
    quality: evaluateThreatQuality(params.architecture, threats),
    degradation: { totals: degradationTotals, byAgent: params.usage?.agentEvents ?? {} },
    tokens: {
      total: (params.usage?.inputTokens ?? 0) + (params.usage?.outputTokens ?? 0),
      input: params.usage?.inputTokens ?? 0,
      output: params.usage?.outputTokens ?? 0,
      byAgent: byAgentTokens,
    },
  }
}

/**
 * Thresholds a healthy run should satisfy. Deliberately loose: this is a
 * regression tripwire, not a grade. `highSeverityShare` is the inflation guard
 * that the old one-directional DREAD grid used to fail.
 */
export const RUN_QUALITY_GATES = {
  maxHighSeverityShare: 0.8,
  minDreadSpread: 1.0,
  minStrideCategories: 3,
  maxStrideShare: 0.6,
  minVerifiableShare: 0.9,
  minDebateAgreement: 0.5,
  maxBestEffortParses: 0,
} as const

export type GateViolation = { gate: string; expected: string; actual: string }

export function checkRunQualityGates(metrics: RunQualityMetrics): GateViolation[] {
  const violations: GateViolation[] = []
  const gates = RUN_QUALITY_GATES

  if (metrics.highSeverityShare > gates.maxHighSeverityShare) {
    violations.push({
      gate: 'maxHighSeverityShare',
      expected: `<= ${gates.maxHighSeverityShare}`,
      actual: String(metrics.highSeverityShare),
    })
  }
  if (metrics.threatCount > 1 && metrics.dread.spread < gates.minDreadSpread) {
    violations.push({
      gate: 'minDreadSpread',
      expected: `>= ${gates.minDreadSpread}`,
      actual: String(metrics.dread.spread),
    })
  }
  if (metrics.stride.categoriesCovered < gates.minStrideCategories) {
    violations.push({
      gate: 'minStrideCategories',
      expected: `>= ${gates.minStrideCategories}`,
      actual: String(metrics.stride.categoriesCovered),
    })
  }
  if (metrics.stride.maxShare > gates.maxStrideShare) {
    violations.push({
      gate: 'maxStrideShare',
      expected: `<= ${gates.maxStrideShare}`,
      actual: String(metrics.stride.maxShare),
    })
  }
  if (metrics.evidence.verifiableShare < gates.minVerifiableShare) {
    violations.push({
      gate: 'minVerifiableShare',
      expected: `>= ${gates.minVerifiableShare}`,
      actual: String(metrics.evidence.verifiableShare),
    })
  }
  if (metrics.debate.assessed > 0 && metrics.debate.agreementShare < gates.minDebateAgreement) {
    violations.push({
      gate: 'minDebateAgreement',
      expected: `>= ${gates.minDebateAgreement}`,
      actual: String(metrics.debate.agreementShare),
    })
  }
  if (!metrics.debate.invalidHonoured) {
    violations.push({
      gate: 'invalidHonoured',
      expected: 'no threat with an invalid ruling in the output',
      actual: 'at least one survived',
    })
  }
  if (metrics.degradation.totals.bestEffortParses > gates.maxBestEffortParses) {
    violations.push({
      gate: 'maxBestEffortParses',
      expected: `<= ${gates.maxBestEffortParses}`,
      actual: String(metrics.degradation.totals.bestEffortParses),
    })
  }
  if (metrics.quality.evidenceIntegrity.unverifiedFindingIds.length) {
    violations.push({
      gate: 'unverifiedCitations',
      expected: '0 findings with unverified quotations',
      actual: metrics.quality.evidenceIntegrity.unverifiedFindingIds.join(', '),
    })
  }
  if (metrics.quality.evidenceIntegrity.unlinkedFindingIds.length) {
    violations.push({
      gate: 'unlinkedCitations',
      expected: '0 findings with unlinked quotations',
      actual: metrics.quality.evidenceIntegrity.unlinkedFindingIds.join(', '),
    })
  }
  return violations
}

/** Human-readable single-run summary for the CLI harness. */
export function formatRunQualityMetrics(name: string, metrics: RunQualityMetrics): string {
  const p = metrics.priorityDistribution
  return [
    `── ${name}`,
    `   threats            ${metrics.threatCount}`,
    `   priority           critical=${p.critical} high=${p.high} medium=${p.medium} low=${p.low} (high-share ${metrics.highSeverityShare})`,
    `   dread              mean=${metrics.dread.mean} min=${metrics.dread.min} max=${metrics.dread.max} spread=${metrics.dread.spread} distinct=${metrics.dread.distinctTotals}`,
    `   stride             ${metrics.stride.categoriesCovered}/6 categories, max-share ${metrics.stride.maxShare}`,
    `   evidence           verifiable ${metrics.evidence.verifiableShare} (cited=${metrics.evidence.withCitedSource} traced=${metrics.evidence.withTraceability} neither=${metrics.evidence.withNeither})`,
    `   citations          arch verified=${metrics.quality.evidenceIntegrity.architectureAnchors.verified} unverified=${metrics.quality.evidenceIntegrity.architectureAnchors.unverified} unlinked=${metrics.quality.evidenceIntegrity.architectureAnchors.unlinked}; rag verified=${metrics.quality.evidenceIntegrity.ragReferences.verified} unverified=${metrics.quality.evidenceIntegrity.ragReferences.unverified} unlinked=${metrics.quality.evidenceIntegrity.ragReferences.unlinked}`,
    `   debate             assessed=${metrics.debate.assessed} agreement=${metrics.debate.agreementShare} invalid-honoured=${metrics.debate.invalidHonoured}`,
    `   duplicates         pairs=${metrics.quality.duplicatePairs.length} rate=${metrics.quality.duplicateRate}`,
    `   coverage           components ${metrics.quality.componentCoverage}`,
    `   contradictions     ${metrics.quality.possibleControlContradictions.length}`,
    `   degradation        best-effort=${metrics.degradation.totals.bestEffortParses} validation-retries=${metrics.degradation.totals.validationRetries} transport-retries=${metrics.degradation.totals.transportRetries}`,
    `   tokens             ${metrics.tokens.total} (in ${metrics.tokens.input} / out ${metrics.tokens.output})`,
  ].join('\n')
}

export type MetricDelta = { metric: string; before: number; after: number; delta: number }

/** Numeric diff against a stored baseline, for "did this prompt change help?" */
export function compareRunQualityMetrics(
  before: RunQualityMetrics,
  after: RunQualityMetrics,
): MetricDelta[] {
  const pick = (metrics: RunQualityMetrics): Record<string, number> => ({
    threatCount: metrics.threatCount,
    highSeverityShare: metrics.highSeverityShare,
    dreadMean: metrics.dread.mean,
    dreadSpread: metrics.dread.spread,
    dreadDistinctTotals: metrics.dread.distinctTotals,
    strideCategoriesCovered: metrics.stride.categoriesCovered,
    strideMaxShare: metrics.stride.maxShare,
    verifiableShare: metrics.evidence.verifiableShare,
    debateAgreementShare: metrics.debate.agreementShare,
    duplicateRate: metrics.quality.duplicateRate,
    componentCoverage: metrics.quality.componentCoverage,
    controlContradictions: metrics.quality.possibleControlContradictions.length,
    bestEffortParses: metrics.degradation.totals.bestEffortParses,
    validationRetries: metrics.degradation.totals.validationRetries,
    tokensTotal: metrics.tokens.total,
  })

  const left = pick(before)
  const right = pick(after)
  return Object.keys(left).map((metric) => ({
    metric,
    before: left[metric]!,
    after: right[metric]!,
    delta: Math.round((right[metric]! - left[metric]!) * 1000) / 1000,
  }))
}
