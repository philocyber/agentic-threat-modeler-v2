import { describe, expect, it } from 'vitest'
import type { UnifiedThreat } from '@/lib/models/types'
import { evidenceState, nextReviewAction, reviewCounts, sortReviewQueue } from '@/lib/ui/review-queue'

const base: UnifiedThreat = {
  id: 'base', title: 'Scenario', component: 'API', methodology: 'STRIDE',
  description: 'Description', impact: 'Impact', mitigation: 'Mitigation',
  scoringStatus: 'validated', priority: 'high', confidenceScore: 0.8,
  dread: { damage: 8, reproducibility: 8, exploitability: 8, affectedUsers: 8, discoverability: 8, total: 8 },
  evidenceSources: [{ sourceType: 'architecture', sourceName: 'RFC', excerpt: 'The API accepts requests.', referenceStatus: 'verified', supportStatus: 'supports' }],
  disposition: 'applicable', reviewStatus: 'pending',
}
const threat = (id: string, fields: Partial<UnifiedThreat> = {}): UnifiedThreat => ({ ...base, id, ...fields })

describe('review queue triage', () => {
  it('leads with actionable pending High/Critical, then verification, other pending and reviewed', () => {
    const items = [
      threat('reviewed', { reviewStatus: 'confirmed', priority: 'critical' }),
      threat('other', { priority: 'medium' }),
      threat('conditional', { disposition: 'conditional', priority: 'critical' }),
      threat('actionable'),
    ]
    expect(sortReviewQueue(items).map((item) => item.id)).toEqual(['actionable', 'conditional', 'other', 'reviewed'])
    expect(reviewCounts(items)).toEqual({ pending: 3, actionable: 1, verify: 1, reviewed: 1 })
  })

  it('does not treat an unverified quote, absent original source, or unscored finding as actionable', () => {
    const unverified = threat('unverified', { evidenceSources: [{ sourceType: 'architecture', sourceName: 'RFC', excerpt: 'Claim', referenceStatus: 'unverified' }] })
    const ragOnly = threat('rag', { evidenceSources: [{ sourceType: 'rag', sourceName: 'Guide', excerpt: 'Generic advice', referenceStatus: 'verified' }] })
    const unscored = threat('unscored', { scoringStatus: 'unscored' })
    const unsupported = threat('unsupported', { evidenceSources: [{ sourceType: 'architecture', sourceName: 'RFC', excerpt: 'Claim', referenceStatus: 'verified' }] })
    expect(evidenceState(unverified)).toBe('check quotation')
    expect(nextReviewAction(unverified)).toBe('Verify source quotation')
    expect(nextReviewAction(ragOnly)).toBe('Locate source evidence')
    expect(nextReviewAction(unsupported)).toBe('Check source support')
    expect(reviewCounts([unverified, ragOnly, unscored, unsupported]).actionable).toBe(0)
  })
})
