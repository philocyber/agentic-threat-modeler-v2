import { describe, expect, it } from 'vitest'
import { deduplicateRawThreats } from '@/lib/agents/dedup'
import type { RawThreat } from '@/lib/models/types'

function threat(partial: Partial<RawThreat> & Pick<RawThreat, 'description' | 'confidenceScore'>): RawThreat {
  return {
    component: 'Payment Orchestrator',
    methodology: 'PASTA',
    impact: 'impact',
    mitigation: 'mitigation',
    evidenceSources: [{ sourceType: 'architecture', sourceName: 'arch', excerpt: 'x' }],
    ...partial,
  }
}

describe('deduplicateRawThreats', () => {
  it('keeps the RAG-backed description when embeddings collide', async () => {
    const pasta = threat({
      methodology: 'PASTA',
      description: 'Stored payment token abuse via conditional network access with corpus citation',
      confidenceScore: 0.95,
      evidenceSources: [{ sourceType: 'rag', sourceName: 'pci-dss', excerpt: 'token storage' }],
    })
    const tree = threat({
      methodology: 'ATTACK_TREE',
      description: 'Generic payment retry abuse from the architecture graph',
      confidenceScore: 0.96,
      evidenceSources: [{ sourceType: 'architecture', sourceName: 'arch', excerpt: 'retry path' }],
    })

    const result = await deduplicateRawThreats([pasta, tree], {
      embed: async () => [1, 0, 0],
      similarityThreshold: 0.5,
    })

    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.description).toContain('corpus citation')
    expect(result.kept[0]?.confidenceScore).toBe(0.96)
    expect(result.kept[0]?.methodologies).toEqual(expect.arrayContaining(['PASTA', 'ATTACK_TREE']))
  })
})
