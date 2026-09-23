// ─── Unified DREAD → priority/severity scoring ───────────────────────────────
//
// Single source of truth for converting a DREAD total (0-10) into a priority
// (agent-facing, lowercase) or a severity (DB `threat_severity` enum, uppercase).
//
// Thresholds: critical >= 8.0, high >= 6.5, medium >= 4.0, low < 4.0.
// Rationale (v2 plan, Fase 0 Bloque B): this was the set used by the majority of
// the pre-unification implementations — both agent-side copies
// (threat-synthesizer.ts and dread-validator.ts) used 6.5 for HIGH. The third
// copy (db/helpers.ts `calculateSeverity`) used 6.0 for HIGH and is now aligned
// to 6.5: DREAD totals in [6.0, 6.5) map to MEDIUM instead of HIGH.

export type ThreatPriority = 'critical' | 'high' | 'medium' | 'low'
export type ThreatSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

const DREAD_CRITICAL_THRESHOLD = 8.0
const DREAD_HIGH_THRESHOLD = 6.5
const DREAD_MEDIUM_THRESHOLD = 4.0

/**
 * Map a DREAD total score (average of the five dimensions) to a priority.
 */
export function dreadToPriority(total: number): ThreatPriority {
  if (total >= DREAD_CRITICAL_THRESHOLD) return 'critical'
  if (total >= DREAD_HIGH_THRESHOLD) return 'high'
  if (total >= DREAD_MEDIUM_THRESHOLD) return 'medium'
  return 'low'
}

/**
 * Map a DREAD total score to the DB `threat_severity` enum value.
 * Same thresholds as `dreadToPriority` — the two are always consistent.
 */
export function dreadToSeverity(total: number): ThreatSeverity {
  return dreadToPriority(total).toUpperCase() as ThreatSeverity
}

/**
 * Average the five DREAD dimensions into the total score.
 */
export function dreadAverage(dread: {
  damage: number
  reproducibility: number
  exploitability: number
  affectedUsers: number
  discoverability: number
}): number {
  return (
    (dread.damage +
      dread.reproducibility +
      dread.exploitability +
      dread.affectedUsers +
      dread.discoverability) /
    5
  )
}

/**
 * Compute severity directly from the five DREAD dimensions.
 */
export function calculateSeverity(dread: {
  damage: number
  reproducibility: number
  exploitability: number
  affectedUsers: number
  discoverability: number
}): ThreatSeverity {
  return dreadToSeverity(Math.round(dreadAverage(dread) * 10) / 10)
}

/**
 * The priority bands as prompt text. Generated from the thresholds above so a
 * prompt can never claim a band the code does not implement.
 */
export function priorityBandsPromptText(): string {
  return [
    `- critical: total >= ${DREAD_CRITICAL_THRESHOLD.toFixed(1)}`,
    `- high: total ${DREAD_HIGH_THRESHOLD.toFixed(1)}–${(DREAD_CRITICAL_THRESHOLD - 0.1).toFixed(1)}`,
    `- medium: total ${DREAD_MEDIUM_THRESHOLD.toFixed(1)}–${(DREAD_HIGH_THRESHOLD - 0.1).toFixed(1)}`,
    `- low: total < ${DREAD_MEDIUM_THRESHOLD.toFixed(1)}`,
  ].join('\n')
}

/** True when a scored total contradicts the band the debate verdict implies. */
export function disagreesWithVerdict(
  total: number,
  verdict: 'critical' | 'high' | 'medium' | 'low' | 'invalid',
): boolean {
  if (verdict === 'invalid') return true
  return dreadToPriority(total) !== verdict
}

/** Numeric scores describe scenario severity, not certainty that a flaw exists. */
export function normalizeThreatScore<T extends import('./types').UnifiedThreat>(threat: T): T {
  if (!threat.dread) return { ...threat, scoringStatus: 'unscored' }
  const dimensions = [threat.dread.damage, threat.dread.reproducibility, threat.dread.exploitability, threat.dread.affectedUsers, threat.dread.discoverability]
  const zeroPlaceholder = dimensions.every(n => n === 0) && threat.disposition !== 'mitigated'
  if (threat.scoringStatus === 'unscored' || zeroPlaceholder || dimensions.some(n => !Number.isFinite(n) || n < 0 || n > 10)) {
    return { ...threat, scoringStatus: 'unscored' }
  }
  const total = Math.round(dreadAverage(threat.dread) * 10) / 10
  return { ...threat, dread: { ...threat.dread, total }, priority: dreadToPriority(total) }
}

export function scoreLabel(threat: import('./types').UnifiedThreat): string {
  return threat.scoringStatus === 'unscored' ? 'Unscored' : `${threat.dread.total.toFixed(1)} / 10`
}

export function severityLabel(threat: import('./types').UnifiedThreat): string {
  return threat.scoringStatus === 'unscored' ? 'Unscored' : threat.priority
}

export function isConditionalScore(threat: import('./types').UnifiedThreat): boolean {
  return threat.disposition === 'conditional' || threat.disposition === 'control_verification_needed'
}
