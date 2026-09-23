import { describe, expect, it } from 'vitest'
import { CORPORATE_COLLECTION_NAME } from '@/lib/rag/corporate-store'
import { chunkGlobalDocument } from '@/lib/rag/global-corpus'
import {
  buildQueryVariants,
  fuseEvidence,
  formatEvidencePack,
  reciprocalRankMerge,
  RAG_POLICIES,
} from '@/lib/rag/router'
import { TECHNICAL_COLLECTIONS } from '@/lib/rag/store'

function item(id: string, domain: 'technical' | 'corporate' | 'reviewer', document = id) {
  return { id, domain, source: `${domain}:${id}`, document, metadata: {} }
}

describe('dual RAG routing', () => {
  it('uses one tool-wide corporate collection', () => {
    expect(CORPORATE_COLLECTION_NAME).toBe('tm_corporate')
  })

  it('chunks shared corpus documents without attaching a project identifier', () => {
    const chunks = chunkGlobalDocument({
      path: 'standards/authentication.md',
      content: 'A'.repeat(1_100),
      sha256: 'hash',
      sourceType: 'standards',
    }, 500, 100)

    expect(chunks).toHaveLength(3)
    expect(chunks[0]).not.toHaveProperty('workspaceId')
  })

  it('does not classify previous company threat models as global technical knowledge', () => {
    expect(Object.values(TECHNICAL_COLLECTIONS)).not.toContain('tm_previous_threat_models')
  })

  it('applies per-domain quotas and role weights', () => {
    const evidence = fuseEvidence(
      {
        technical: [item('t1', 'technical'), item('t2', 'technical')],
        corporate: [item('c1', 'corporate'), item('c2', 'corporate')],
        reviewer: [item('r1', 'reviewer'), item('r2', 'reviewer')],
      },
      {
        quotas: { technical: 1, corporate: 1, reviewer: 1 },
        weights: { technical: 1, corporate: 0.5, reviewer: 2 },
      },
    )

    expect(evidence.map((entry) => entry.id)).toEqual(['r1', 't1', 'c1'])
    expect(evidence).toHaveLength(3)
  })

  it('deduplicates identical evidence and keeps the strongest ranking', () => {
    const evidence = fuseEvidence(
      {
        technical: [item('technical-copy', 'technical', 'same evidence')],
        corporate: [{
          ...item('corporate-copy', 'corporate', 'same evidence'),
          source: 'technical:technical-copy',
        }],
        reviewer: [],
      },
      {
        quotas: { technical: 2, corporate: 2, reviewer: 2 },
        weights: { technical: 1, corporate: 2, reviewer: 1 },
      },
    )

    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.domain).toBe('corporate')
  })

  it('formats provenance instead of blending sources invisibly', () => {
    const pack = formatEvidencePack([
      { ...item('t1', 'technical'), rank: 1, fusionScore: 1 },
      { ...item('c1', 'corporate'), rank: 1, fusionScore: 1 },
      { ...item('r1', 'reviewer'), rank: 1, fusionScore: 1 },
    ])

    expect(pack.match(/\[RAG-[a-f0-9]{24}\]/g)).toHaveLength(3)
    expect(pack).toContain('technical | technical:t1')
    expect(pack).toContain('corporate | corporate:c1')
    expect(pack).toContain('reviewer | reviewer:r1')
  })

  it('gives red and blue teams intentionally different retrieval policies', () => {
    expect(RAG_POLICIES.red_team.quotas.technical).toBeGreaterThan(
      RAG_POLICIES.red_team.quotas.corporate,
    )
    expect(RAG_POLICIES.blue_team.quotas.corporate).toBeGreaterThan(
      RAG_POLICIES.blue_team.quotas.technical,
    )
  })

  it('builds a focused query variant from step facets', () => {
    const variants = buildQueryVariants({
      query: 'Validate the current threat batch',
      facets: ['Component: Payments API', 'Threat: JWT audience bypass'],
    }, null)

    expect(variants).toHaveLength(2)
    expect(variants[1]).toContain('Payments API')
    expect(variants[1]).toContain('JWT audience bypass')
  })

  it('raises evidence that ranks across multiple query variants', () => {
    const repeated = item('repeated', 'technical')
    const merged = reciprocalRankMerge([
      [item('one-off-a', 'technical'), repeated],
      [item('one-off-b', 'technical'), repeated],
    ])

    expect(merged[0]?.id).toBe('repeated')
    expect(merged[0]?.metadata).toMatchObject({ queryMatches: 2 })
  })
})

it('removes duplicate and repeated-source passages before filling domain quotas', () => {
  const same = { ...item('a', 'technical', 'first'), source: 'book.md' }
  const evidence = fuseEvidence({ technical: [same, same, { ...same, id: 'b', document: 'second' }, { ...same, id: 'c', document: 'third' }, item('d', 'technical')], corporate: [], reviewer: [] }, { quotas: { technical: 3, corporate: 0, reviewer: 0 }, weights: { technical: 1, corporate: 1, reviewer: 1 } })
  expect(evidence.map(e => e.id)).toEqual(['a', 'b', 'd'])
})

it('budgets the rendered metadata and qualifications, including the first passage', async () => {
  const { applyContextBudget } = await import('../router')
  const oversized = { ...item('a', 'technical', 'short'), metadata: { qualification: 'x'.repeat(1000) }, rank: 1, fusionScore: 1 }
  const small = { ...item('b', 'technical', 'small'), rank: 2, fusionScore: 0.5 }
  expect(applyContextBudget([oversized, small], 500).map(e => e.id)).toEqual(['b'])
})
