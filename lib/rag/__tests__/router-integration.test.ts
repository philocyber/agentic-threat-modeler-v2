import { describe, expect, it, vi } from 'vitest'
import { DualRAGRouter } from '../router'
import { RAGTraceCollector } from '../trace'
import type { RAGStoreManager } from '../store'
import { searchGlobalCorpus } from '../global-corpus'
import { searchReviewedThreatKnowledge } from '@/lib/storage/review-learning'

vi.mock('../global-corpus', () => ({ searchGlobalCorpus: vi.fn(async () => []) }))
vi.mock('@/lib/storage/review-learning', () => ({ searchReviewedThreatKnowledge: vi.fn(async () => []) }))

function stores() {
  return {
    getConfiguredTopK: () => 5,
    hierarchicalQuery: vi.fn(async () => ({ results: [], cacheHits: 0 })),
    query: vi.fn(async () => []),
    treeQuery: vi.fn(async () => []),
  }
}

describe('router evidence packs', () => {
  it('never searches reviewer history without a system ID', async () => {
    vi.mocked(searchGlobalCorpus).mockResolvedValue([])
    vi.mocked(searchReviewedThreatKnowledge).mockClear()
    await new DualRAGRouter(stores() as unknown as RAGStoreManager, null).queryPack({ query: 'gateway bypass' }, 'analyst')
    expect(searchReviewedThreatKnowledge).not.toHaveBeenCalled()
    await new DualRAGRouter(stores() as unknown as RAGStoreManager, null, undefined, undefined, 'financebot', 'current-run')
      .queryPack({ query: 'gateway bypass' }, 'analyst')
    expect(searchReviewedThreatKnowledge).toHaveBeenCalledWith(expect.stringContaining('gateway bypass'), 'financebot', 2, 'current-run')
  })
  it('delivers only relevant, compatible passages with traceable versions', async () => {
    vi.mocked(searchGlobalCorpus).mockResolvedValue([
      { id: 'grants', path: 'grants.md', excerpt: 'SAMPLE_READER grants are unknown. Export effective grants.', score: 2, metadata: { system: 'Example Service', sha256: 'v1' } },
      { id: 'other', path: 'other.md', excerpt: 'SAMPLE_READER grants allow all resources.', score: 3, metadata: { system: 'Other' } },
      { id: 'playbook', path: 'playbook.md', excerpt: 'SAMPLE_READER grants search guidance.', score: 4, metadata: { doc_type: 'playbook' } },
      { id: 'unrelated', path: 'payroll.md', excerpt: 'Payroll policy.', score: 1, metadata: {} },
    ])
    const trace = new RAGTraceCollector()
    const router = new DualRAGRouter(stores() as unknown as RAGStoreManager, null, trace)
    const first = await router.queryPack({ query: 'SAMPLE_READER effective grants', system: 'Example Service' }, 'analyst')
    expect(first.status).toBe('retrieved')
    expect(first.passages).toHaveLength(1)
    expect(first.passages[0]).toMatchObject({ source: 'grants.md', version: 'v1', excerpt: 'SAMPLE_READER grants are unknown. Export effective grants.' })
    const second = await router.queryPack({ query: 'SAMPLE_READER grants', system: 'Example Service' }, 'analyst')
    expect(second.passages[0]?.citationId).toBe(first.passages[0]?.citationId)
    expect(trace.snapshot().entries[0]?.rejected).toMatchObject({ different_system: 1, unrelated_playbook: 1, no_question_overlap: 1 })
    expect(trace.getPassages()).toHaveLength(1)
  })

  it('reports absence instead of returning weak filler', async () => {
    vi.mocked(searchGlobalCorpus).mockResolvedValue([{ id: 'x', path: 'payroll.md', excerpt: 'Payroll policy.', score: 1, metadata: {} }])
    const router = new DualRAGRouter(stores() as unknown as RAGStoreManager, null)
    expect(await router.queryPack({ query: 'memory namespace isolation' }, 'blue_team')).toMatchObject({ status: 'no_evidence', passages: [] })
  })

  it('enforces the query budget before calling retrieval, including resumed work', async () => {
    const trace = new RAGTraceCollector()
    for (let i = 0; i < 40; i++) trace.record({ id: `q${i}`, profile: 'analyst', originalQuery: 'grants', routedQuery: 'grants', startedAt: '', durationMs: 0, budgetCharacters: 9000, selectedCharacters: 0, selected: [], discardedCount: 0, cacheHits: 0 })
    const store = stores()
    const router = new DualRAGRouter(store as unknown as RAGStoreManager, null, trace)
    expect(await router.queryPack({ query: 'grants' }, 'analyst')).toMatchObject({ status: 'budget_exhausted', passages: [] })
    expect(store.query).not.toHaveBeenCalled()
    expect(store.hierarchicalQuery).not.toHaveBeenCalled()
  })
})
