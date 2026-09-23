import { describe, it, expect } from 'vitest'
import { calibrateCandidate, inScopeCandidates } from '../candidate-quality'
import { sameAttackMechanism, deduplicateRawThreats } from '../dedup'
import { rawToUnified } from '../reconcile'
import type { RawThreat, ArchitectureData } from '@/lib/models/types'
const candidate: RawThreat = {
  component: 'Store', methodology: 'PASTA', description: 'Path traversal reads cross-run artifacts.', impact: 'Read private artifacts', mitigation: 'Verify confinement', confidenceScore: 0.82,
  evidenceSources: [{ sourceType: 'architecture', sourceName: 'CTRL-17', excerpt: 'Path confinement requires verification; implementation unverified.' }],
  reasoning: 'The implementation is unverified.', traceability: { components: ['Host', 'Store'] },
}
describe('candidate evidence calibration', () => {
  it('caps confidence in an unverified precondition without inventing a severity', () => {
    const t = calibrateCandidate(candidate)
    expect(t.confidenceScore).toBe(0.69)
    expect(t.disposition).toBe('control_verification_needed')
    expect(t.preconditions?.[0]).toContain('CTRL-17')
    expect(t).not.toHaveProperty('dread')
  })
  it('does not change confidence when a bypass is directly evidenced', () => {
    const t = { ...candidate, evidenceSources: [{ sourceType: 'architecture' as const, sourceName: 'test', excerpt: 'A ../ request returned the adjacent run report.' }], reasoning: 'Reproduced against the deployed build.' }
    expect(calibrateCandidate(t).confidenceScore).toBe(0.82)
  })
  it('merges the same traversal path before debate despite different embeddings', async () => {
    const other = { ...candidate, component: 'Sample Framework', methodology: 'ATTACK_TREE' as const, description: 'Operator input traverses Host paths to read cross-run artifacts.' }
    expect(sameAttackMechanism(candidate, other)).toBe(true)
    const result = await deduplicateRawThreats([candidate, other], { embedBatch: async () => [[1, 0], [0, 1]] })
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.methodologies).toEqual(['PASTA', 'ATTACK_TREE'])
  })
  it('does not merge the same mechanism on unrelated assets', () => {
    expect(sameAttackMechanism(candidate, { ...candidate, component: 'Other store', traceability: { components: ['Other store'] } })).toBe(false)
  })
  it('does not turn confidence into fallback DREAD', () => {
    expect(rawToUnified(candidate).scoringStatus).toBe('unscored')
    expect(rawToUnified({ ...candidate, confidenceScore: 0.99 }).dread).toEqual(rawToUnified(candidate).dread)
  })
  it('excludes explicitly adjacent systems', () => {
    const architecture = { components: [{ name: 'Store', type: 'service', scope: 'internal', relationship: 'adjacent' }] } as ArchitectureData
    expect(inScopeCandidates([candidate], architecture)).toEqual([])
  })
})
