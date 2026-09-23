import { describe, expect, it } from 'vitest'
import { filterByConfidence } from '@/lib/agents/base'
import { deduplicateRawThreats } from '@/lib/agents/dedup'
import { diffThreatRuns } from '@/lib/threats/diff'
import type { RawThreat, UnifiedThreat } from '@/lib/models/types'

function raw(partial: Partial<RawThreat> & Pick<RawThreat, 'description'>): RawThreat {
  return {
    component: partial.component ?? 'API',
    methodology: partial.methodology ?? 'STRIDE',
    impact: partial.impact ?? 'impact',
    mitigation: partial.mitigation ?? 'mitigation',
    confidenceScore: partial.confidenceScore ?? 0.8,
    evidenceSources: partial.evidenceSources ?? [{ sourceType: 'architecture', sourceName: 'arch', excerpt: 'component present' }],
    ...partial,
  }
}

describe('filterByConfidence evidence enforcement', () => {
  it('drops high priority threats without evidence when required', () => {
    const threats = [
      { confidenceScore: 0.9, priority: 'high', evidenceSources: [] },
      {
        confidenceScore: 0.9,
        priority: 'high',
        evidenceSources: [{ sourceType: 'architecture', sourceName: 'api', excerpt: 'endpoint exposed' }],
      },
    ]
    const { kept } = filterByConfidence(threats, 0.5, true)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.evidenceSources[0]?.excerpt).toBe('endpoint exposed')
  })
})

describe('deduplicateRawThreats', () => {
  it('uses lexical fallback and preserves attack tree fields on merge', async () => {
    const threats = [
      raw({
        description: 'SQL injection in login form allows credential bypass',
        attackTree: { rootGoal: 'Steal creds', tree: { goal: 'inject', type: 'LEAF' }, textRepresentation: 'tree-a' },
      }),
      raw({
        description: 'SQL injection in login allows credential bypass attack',
        confidenceScore: 0.95,
        attackTree: { rootGoal: 'Steal creds', tree: { goal: 'inject', type: 'LEAF' }, textRepresentation: 'tree-b' },
      }),
    ]

    const { kept, stats } = await deduplicateRawThreats(threats, { similarityThreshold: 0.5 })
    expect(kept).toHaveLength(1)
    expect(kept[0]?.attackTree?.textRepresentation).toBeTruthy()
    expect(stats.embeddingMode).toBe('lexical')
    expect(stats.embeddingDuplicates).toBe(1)
  })
})

describe('diffThreatRuns', () => {
  it('classifies added, removed, and changed threats', () => {
    const base: UnifiedThreat[] = [
      {
        id: '1',
        component: 'API',
        methodology: 'STRIDE',
        description: 'IDOR on user endpoint allows cross-tenant data access for any authenticated user',
        impact: 'impact',
        mitigation: 'mitigation',
        dread: { damage: 7, reproducibility: 8, exploitability: 8, affectedUsers: 8, discoverability: 7, total: 7.6 },
        priority: 'high',
        confidenceScore: 0.8,
        evidenceSources: [],
      },
    ]
    const compare: UnifiedThreat[] = [
      {
        ...base[0]!,
        id: '2',
        priority: 'critical',
        dread: { ...base[0]!.dread, total: 8.5 },
      },
      {
        id: '3',
        component: 'DB',
        methodology: 'PASTA',
        description: 'Unencrypted backup exposure enables offline PII extraction from database dumps',
        impact: 'impact',
        mitigation: 'mitigation',
        dread: { damage: 8, reproducibility: 6, exploitability: 5, affectedUsers: 9, discoverability: 6, total: 6.8 },
        priority: 'high',
        confidenceScore: 0.7,
        evidenceSources: [],
      },
    ]

    const diff = diffThreatRuns('run-a', 'run-b', base, compare)
    expect(diff.changed).toHaveLength(1)
    expect(diff.added).toHaveLength(1)
    expect(diff.removed).toHaveLength(0)
  })
})
