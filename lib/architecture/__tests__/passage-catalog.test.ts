import { describe, expect, it } from 'vitest'
import { createSourceEvidence } from '@/lib/architecture/source-evidence'
import { buildPassageCatalog, contentFingerprint, passageById } from '../passage-catalog'
import { applyCitationIntegrity } from '@/lib/evaluation/citation-integrity'
import { makePassage } from '@/lib/rag/evidence'
import type { EvidenceSource } from '@/lib/db/schema'

const source = createSourceEvidence(`# Gateway
Kong Gateway terminates TLS for tenant exports and forwards scoped JWTs.

# Network
ExportWorker runs in a private subnet. Only the queue can invoke its job handler.`)

describe('canonical passage catalog', () => {
  it('gives stable identifiers, fingerprints and related sections', () => {
    const catalog = buildPassageCatalog(source)
    expect(catalog.passages.map((p) => p.id)).toEqual(['SRC-0001', 'SRC-0002'])
    expect(catalog.passages[0]?.fingerprint).toBe(contentFingerprint(catalog.passages[0]!.text))
    expect(passageById(catalog, 'SRC-0001')?.relatedIds).toContain('SRC-0002')
  })

  it('replaces reconstructed citations with catalog text and rejects unknown IDs', () => {
    const finding = {
      component: 'Kong Gateway',
      description: 'An attacker forges a token at Kong Gateway.',
      confidenceScore: 0.92,
      evidenceSources: [{
        sourceType: 'architecture' as const,
        sourceName: 'SRC-0001',
        excerpt: 'Kong Gateway has no authentication whatsoever.',
      } satisfies EvidenceSource],
    }
    const resolved = applyCitationIntegrity(finding, { source })
    expect(resolved.evidenceSources[0]?.referenceStatus).toBe('verified')
    expect(resolved.evidenceSources[0]?.excerpt).toContain('Kong Gateway terminates TLS')
    expect(resolved.evidenceSources[0]?.excerpt).not.toContain('no authentication whatsoever')

    const missing = applyCitationIntegrity({
      ...finding,
      evidenceSources: [{ sourceType: 'architecture', sourceName: 'SRC-9999', excerpt: 'invented' }],
    }, { source })
    expect(missing.evidenceSources[0]?.referenceStatus).toBe('unverified')
  })

  it('treats unicode-normalized text as the same fingerprint', () => {
    const composed = 'Café gateway'
    const decomposed = 'Cafe\u0301 gateway'
    expect(contentFingerprint(composed)).toBe(contentFingerprint(decomposed))
  })

  it('does not treat a verified RAG passage from another system as proof', () => {
    const passage = makePassage({
      id: 'payments',
      domain: 'corporate',
      source: 'other-system.md',
      document: 'The payments ledger in System B stores ePHI without encryption.',
      metadata: { sha256: 'v1' },
    }, 'q1')
    const checked = applyCitationIntegrity({
      component: 'Kong Gateway',
      description: 'Kong Gateway leaks tenant JWTs.',
      confidenceScore: 0.9,
      evidenceSources: [{ sourceType: 'rag', sourceName: passage.citationId, excerpt: passage.excerpt }],
    }, { passages: [passage] })
    expect(checked.evidenceSources[0]?.referenceStatus).toBe('verified')
    expect(checked.evidenceSources[0]?.supportStatus).toBe('unlinked')
    expect(checked.evidenceSources[0]?.relevanceStatus).toBe('not_relevant')
  })
})
