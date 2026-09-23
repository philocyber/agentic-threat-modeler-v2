import { describe, expect, it } from 'vitest'
import { reconcileSynthesizedThreats } from '../reconcile'
import type { RawThreat, UnifiedThreat } from '@/lib/models/types'

function raw(candidateId: string, description: string, methodology: RawThreat['methodology']): RawThreat {
  return { candidateId, component: 'Gateway', methodology, description, impact: 'Impact', mitigation: 'Mitigation', confidenceScore: 0.8, evidenceSources: [{ sourceType: 'architecture', sourceName: 'fixture', excerpt: description }] }
}

function unified(id: string, title: string, description: string, methodology: UnifiedThreat['methodology']): UnifiedThreat {
  return { id, title, component: 'Gateway', methodology, description, impact: 'Impact', mitigation: 'Mitigation', dread: { damage: 6, reproducibility: 6, exploitability: 6, affectedUsers: 6, discoverability: 6, total: 6 }, priority: 'medium', confidenceScore: 0.8, evidenceSources: [] }
}

describe('global threat reconciliation', () => {
  it('does not merge cost and identity findings on the same component and boundary', () => {
    const candidates = [raw('COST-1', 'Unbounded autonomous retries exhaust model budgets.', 'STRIDE'), raw('IAM-1', 'Shared machine credentials cross authorization boundaries.', 'PASTA')]
    const findings = candidates.map((c, i) => ({ ...unified(String(i), c.description, c.description, c.methodology), sourceCandidateIds: [c.candidateId!], traceability: { components: ['Gateway'], trustBoundaries: ['Boundary'] } }))
    expect(reconcileSynthesizedThreats(findings, candidates, 15)).toHaveLength(2)
  })
  it('restores omitted candidates within the cap and preserves unknown disposition and complete mitigation', () => {
    const candidates = Array.from({ length: 12 }, (_, i) => ({ ...raw(`C-${i}`, `Independent mechanism ${i}`, 'STRIDE'), disposition: 'control_verification_needed' as const, mitigation: `Verify control ${i} and test denial on the unauthorized route.` }))
    const finding = { ...unified('one', 'Control verification', candidates[0]!.description, 'STRIDE'), sourceCandidateIds: ['C-0'], disposition: 'applicable' as const, mitigation: 'Verify...' }
    const result = reconcileSynthesizedThreats([finding], candidates, 15)
    expect(result).toHaveLength(12)
    expect(result[0]?.disposition).toBe('control_verification_needed')
    expect(result[0]?.mitigation).toBe(candidates[0]!.mitigation)
  })
  it('merges recurring cross-batch threats and backfills unique candidate coverage', () => {
    const candidates = [
      raw('STRIDE-01', 'JWT verification can be bypassed through an inconsistent route policy.', 'STRIDE'),
      raw('PASTA-02', 'JWT verification bypass through inconsistent route policies allows impersonation.', 'PASTA'),
      ...Array.from({ length: 10 }, (_, index) => raw(`STRIDE-${index + 3}`, `Unique architecture threat number ${index + 1} affecting banking flow ${index + 1}.`, 'STRIDE')),
    ]
    const result = reconcileSynthesizedThreats([
      { ...unified('one', 'JWT verification bypass', 'JWT verification can be bypassed through an inconsistent route policy.', 'STRIDE'), sourceCandidateIds: ['STRIDE-01', 'PASTA-02'] },
      { ...unified('two', 'JWT verification bypass recurring', 'JWT verification bypass through inconsistent route policies allows impersonation.', 'PASTA'), sourceCandidateIds: ['STRIDE-01', 'PASTA-02'] },
    ], candidates, 15)
    expect(result.filter((threat) => /jwt verification bypass/i.test(threat.title ?? '')).length).toBe(1)
    expect(result.length).toBeGreaterThanOrEqual(10)
    expect(result[0]?.methodologies).toEqual(expect.arrayContaining(['STRIDE', 'PASTA']))
  })

  it('does not merge similar IDOR findings for different endpoints', () => {
    const candidates = [
      { ...raw('STRIDE-01', 'IDOR permits cross-tenant access on user lookup.', 'STRIDE'), traceability: { endpoints: ['GET /users/:id'], components: ['Gateway'] } },
      { ...raw('PASTA-02', 'IDOR permits cross-tenant access on invoice lookup.', 'PASTA'), traceability: { endpoints: ['GET /invoices/:id'], components: ['Gateway'] } },
    ]
    const findings = [
      { ...unified('one', 'IDOR on lookup', 'IDOR permits cross-tenant access on user lookup.', 'STRIDE'), sourceCandidateIds: ['STRIDE-01'], traceability: candidates[0]!.traceability },
      { ...unified('two', 'IDOR on lookup', 'IDOR permits cross-tenant access on invoice lookup.', 'PASTA'), sourceCandidateIds: ['PASTA-02'], traceability: candidates[1]!.traceability },
    ]
    expect(reconcileSynthesizedThreats(findings, candidates, 15)).toHaveLength(2)
  })
})
