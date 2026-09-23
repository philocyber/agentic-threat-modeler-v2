import { describe, expect, it } from 'vitest'
import { recoverBillingBlockedResult } from '../billing-recovery'
import { ProviderBillingError } from '@/lib/llm/provider-errors'
import { rawToUnified } from '@/lib/agents/reconcile'
import type { ArchitectureData, RawThreat } from '@/lib/models/types'

const architecture = { systemDescription: 'Test', components: [], dataFlows: [], trustBoundaries: [] } as unknown as ArchitectureData
const raw: RawThreat = { candidateId: 'C-1', component: 'Gateway', methodology: 'STRIDE', description: 'Spoofed gateway requests', impact: 'Access', mitigation: 'Verify identity', confidenceScore: 0.8, evidenceSources: [] }

describe('billing recovery', () => {
  it('retains accepted candidates without reviving filtered ones or inventing scores', () => {
    const result = recoverBillingBlockedResult({}, [
      { phase: 'architecture_parser', architecture },
      { phase: 'stride_analyst', threats: [raw, { ...raw, candidateId: 'C-2' }] },
      { phase: 'pre_dedup', threatsKept: [raw], filteredCount: 1 },
    ], new ProviderBillingError())
    expect(result.threatsFinal).toHaveLength(1)
    expect(result.threatsFinal?.[0]).toMatchObject({ scoringStatus: 'unscored', sourceCandidateIds: ['C-1'] })
    expect(result.filteredCount).toBe(1)
    expect(result.errors?.join(' ')).toContain('billing')
  })

  it('preserves an empty completed gate instead of falling back to raw candidates', () => {
    const result = recoverBillingBlockedResult({ architectureData: architecture, strideThreats: [raw], threatsKept: [] }, [], new ProviderBillingError())
    expect(result.threatsFinal).toEqual([])
  })

  it('keeps completed scoring from compatible checkpoints', () => {
    const scored = { ...rawToUnified(raw), scoringStatus: 'validated' as const }
    const result = recoverBillingBlockedResult({ architectureData: architecture, threatsFinal: [scored] }, [], new ProviderBillingError())
    expect(result.threatsFinal).toEqual([scored])
  })

  it('does not turn parser failures or unrelated errors into partial successes', () => {
    expect(() => recoverBillingBlockedResult({}, [], new ProviderBillingError())).toThrow(ProviderBillingError)
    expect(() => recoverBillingBlockedResult({ architectureData: architecture }, [], new Error('network failed'))).toThrow('network failed')
  })
})
