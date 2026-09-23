import { describe, expect, it } from 'vitest'
import { RAGTraceCollector } from '../trace'

describe('RAG trace collector', () => {
  it('stores retrieval metadata without storing corpus excerpts', () => {
    const collector = new RAGTraceCollector()
    collector.record({ id: 'q1', profile: 'analyst', originalQuery: 'jwt threats', routedQuery: 'jwt threats kong', queryVariants: ['jwt threats kong', 'jwt threats API Gateway'], startedAt: new Date(0).toISOString(), durationMs: 12, budgetCharacters: 1_000, selectedCharacters: 300, discardedCount: 2, cacheHits: 1, selected: [{ id: 's1', domain: 'technical', source: 'C:\\repo\\knowledge_base\\technical\\jwt.md', rank: 1, fusionScore: 0.1, characters: 300 }] })
    const snapshot = collector.snapshot()
    expect(snapshot.entries[0]?.selected[0]?.source).toBe('technical/jwt.md')
    expect(JSON.stringify(snapshot)).not.toContain('corpus excerpt')
    expect(snapshot.totals.cacheHits).toBe(1)
    expect(snapshot.entries[0]?.queryVariants).toHaveLength(2)
  })
})

it('restores stable passages once and rejects changed excerpts during resume', async () => {
  const { makePassage } = await import('../evidence')
  const passage = makePassage({ id: 'chunk-1', domain: 'corporate', source: 'grants.md', document: 'Grants remain unknown.', metadata: { sha256: 'version-1' } }, 'q1')
  const trace = new RAGTraceCollector()
  trace.record({ id: 'q1', profile: 'analyst', originalQuery: 'grants', routedQuery: 'grants', startedAt: '', durationMs: 0, budgetCharacters: 9000, selectedCharacters: 200, discardedCount: 0, cacheHits: 0, selected: [{ id: 'chunk-1', domain: 'corporate', source: 'grants.md', rank: 1, fusionScore: 1, characters: passage.excerpt.length, passage }] })
  const resumed = new RAGTraceCollector()
  resumed.restore(trace.snapshot())
  resumed.restore(trace.snapshot())
  expect(resumed.getPassages()).toEqual([passage])
  expect(resumed.snapshot().totals.queries).toBe(1)
  const corrupted = trace.snapshot()
  corrupted.entries[0]!.selected[0]!.passage = { ...passage, excerpt: 'Grants are absent.' }
  const rejected = new RAGTraceCollector()
  rejected.restore(corrupted)
  expect(rejected.getPassages()).toEqual([])
})
