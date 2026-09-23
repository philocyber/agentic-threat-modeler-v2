import { describe, expect, it } from 'vitest'
import { evaluateThreatQuality } from '../threat-quality'
import type { ArchitectureData, UnifiedThreat } from '@/lib/models/types'

const architecture = {
  components: [{ name: 'Gateway', type: 'service', scope: 'external' }],
  factLedger: {
    controls: [{ name: 'TLS in transit', status: 'enabled' }],
  },
} as unknown as ArchitectureData

function threat(overrides: Partial<UnifiedThreat>): UnifiedThreat {
  return {
    id: 'T-1',
    component: 'Gateway',
    methodology: 'STRIDE',
    description: 'Gateway accepts plaintext after TLS is terminated',
    impact: 'Disclosure',
    mitigation: 'Keep TLS to the origin',
    confidenceScore: 0.7,
    evidenceSources: [],
    dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5, total: 5 },
    priority: 'medium',
    scoringStatus: 'validated',
    ...overrides,
  } as UnifiedThreat
}

describe('stage 1 semantic regressions', () => {
  it('flags contradictory controls without deleting the candidate', () => {
    const report = evaluateThreatQuality(architecture, [threat({
      description: 'The Gateway exposes plaintext transport without TLS',
    })])
    expect(report.possibleControlContradictions.length).toBeGreaterThan(0)
    expect(report.threatCount).toBe(1)
  })

  it('keeps architectural duplicates as one finding with merged references', async () => {
    const { deduplicateRawThreats } = await import('@/lib/agents/dedup')
    const result = await deduplicateRawThreats([
      {
        component: 'Gateway', methodology: 'STRIDE', description: 'Unsigned callbacks can be replayed at the Gateway webhook.',
        impact: 'Tampering', mitigation: 'Sign requests', confidenceScore: 0.8,
        evidenceSources: [{ sourceType: 'architecture', sourceName: 'SRC-0001', excerpt: 'Gateway' }],
      },
      {
        component: 'Gateway', methodology: 'PASTA', description: 'Unsigned callbacks can be replayed at the Gateway webhook.',
        impact: 'Tampering', mitigation: 'Sign requests', confidenceScore: 0.7,
        evidenceSources: [{ sourceType: 'architecture', sourceName: 'SRC-0002', excerpt: 'webhook' }],
      },
    ])
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.evidenceSources).toHaveLength(2)
    expect(result.kept[0]?.methodologies).toEqual(expect.arrayContaining(['STRIDE', 'PASTA']))
  })
})
