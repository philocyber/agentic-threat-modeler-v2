import { describe, expect, it } from 'vitest'
import {
  calculateSeverity,
  dreadAverage,
  dreadToPriority,
  dreadToSeverity,
} from '@/lib/models/scoring'

// Thresholds (single source of truth): critical >= 8.0, high >= 6.5,
// medium >= 4.0, low < 4.0. Chosen because both agent-side implementations
// used 6.5 for HIGH; the old db/helpers copy used 6.0 and is now aligned.

describe('dreadToPriority', () => {
  it('maps the top of the scale to critical', () => {
    expect(dreadToPriority(10)).toBe('critical')
    expect(dreadToPriority(8.0)).toBe('critical')
  })

  it('maps 7.99 down to high (just below critical boundary)', () => {
    expect(dreadToPriority(7.99)).toBe('high')
  })

  it('maps the high band boundaries', () => {
    expect(dreadToPriority(6.5)).toBe('high')
    expect(dreadToPriority(6.49)).toBe('medium')
  })

  it('maps the medium band boundaries', () => {
    expect(dreadToPriority(4.0)).toBe('medium')
    expect(dreadToPriority(3.99)).toBe('low')
  })

  it('maps the bottom of the scale to low', () => {
    expect(dreadToPriority(0)).toBe('low')
  })
})

describe('dreadToSeverity', () => {
  it('uses the same thresholds as dreadToPriority, uppercased for the DB enum', () => {
    expect(dreadToSeverity(8.0)).toBe('CRITICAL')
    expect(dreadToSeverity(7.99)).toBe('HIGH')
    expect(dreadToSeverity(6.5)).toBe('HIGH')
    expect(dreadToSeverity(6.49)).toBe('MEDIUM')
    expect(dreadToSeverity(4.0)).toBe('MEDIUM')
    expect(dreadToSeverity(3.99)).toBe('LOW')
  })
})

describe('dreadAverage', () => {
  it('averages the five DREAD dimensions', () => {
    expect(
      dreadAverage({ damage: 7, reproducibility: 7, exploitability: 7, affectedUsers: 7, discoverability: 7 })
    ).toBe(7)
  })
})

describe('calculateSeverity', () => {
  it('computes severity from the five dimensions via the shared thresholds', () => {
    const all = (n: number) => ({
      damage: n,
      reproducibility: n,
      exploitability: n,
      affectedUsers: n,
      discoverability: n,
    })
    expect(calculateSeverity(all(9))).toBe('CRITICAL')
    expect(calculateSeverity(all(7))).toBe('HIGH')
    expect(calculateSeverity(all(5))).toBe('MEDIUM')
    expect(calculateSeverity(all(2))).toBe('LOW')
  })

  it('maps an average of 6.5 to HIGH and 6.0 to MEDIUM (unified 6.5 threshold)', () => {
    const avg = (total: number) => ({
      damage: total,
      reproducibility: total,
      exploitability: total,
      affectedUsers: total,
      discoverability: total,
    })
    expect(calculateSeverity(avg(6.5))).toBe('HIGH')
    // Deliberate behavior change vs the old db/helpers copy (HIGH >= 6.0):
    // a 6.0 average is now MEDIUM everywhere.
    expect(calculateSeverity(avg(6.0))).toBe('MEDIUM')
  })
})

import { normalizeThreatScore, scoreLabel, severityLabel } from '../scoring'

it('keeps zero placeholders unscored while allowing an explicitly mitigated zero-risk scenario', () => {
  const item = { ...fixture(), scoringStatus: 'validated' as const,
    dread: { damage: 0, reproducibility: 0, exploitability: 0, affectedUsers: 0, discoverability: 0, total: 0 } }
  expect(normalizeThreatScore(item).scoringStatus).toBe('unscored')
  expect(normalizeThreatScore({ ...item, disposition: 'mitigated' }).scoringStatus).toBe('validated')
})
import { rawToUnified } from '@/lib/agents/reconcile'
import { mapUnifiedThreatToRow, mapRowToUnifiedThreat } from '@/lib/db/helpers'
import { generateCSV } from '@/lib/agents/report-generator'
const fixture = () => rawToUnified({ component: 'Store', methodology: 'PASTA', description: 'Potential traversal', mitigation: 'Verify confinement', impact: 'Artifact access', confidenceScore: 0.9, evidenceSources: [] })
describe('score integrity and persistence', () => {
  it('recomputes both total and band instead of trusting a generated total', () => {
    const t = normalizeThreatScore({ ...fixture(), scoringStatus: 'validated' as const, dread: { damage: 9, reproducibility: 9, exploitability: 9, affectedUsers: 9, discoverability: 9, total: 5 } })
    expect(t.dread.total).toBe(9)
    expect(t.priority).toBe('critical')
  })
  it('persists a missing score as null dimensions and survives a reload as unscored', () => {
    const row = mapUnifiedThreatToRow(fixture(), 'run')
    expect(row.dreadDamage).toBeNull()
    expect(row.severity).toBeNull()
    const restored = mapRowToUnifiedThreat(row as Parameters<typeof mapRowToUnifiedThreat>[0])
    expect(restored.scoringStatus).toBe('unscored')
    expect(scoreLabel(restored)).toBe('Unscored')
    expect(severityLabel(restored)).toBe('Unscored')
    expect(generateCSV([restored])).toContain('UNSCORED')
  })
  it('marks invalid numeric dimensions unscored rather than assigning Low', () => {
    const t = fixture()
    expect(normalizeThreatScore({ ...t, scoringStatus: 'validated', dread: { ...t.dread, damage: Number.NaN } }).scoringStatus).toBe('unscored')
  })
})
