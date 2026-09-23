import { describe, expect, it } from 'vitest'
import type { EvidenceSource } from '@/lib/db/schema'
import { applyCitationIntegrity, verifyEvidenceSource } from '../citation-integrity'
import { makePassage, validateEvidenceSources } from '@/lib/rag/evidence'
import type { SourceEvidence } from '@/lib/architecture/source-evidence'

const source: SourceEvidence = {
  version: 1,
  sections: [
    {
      id: 'SRC-0001',
      heading: 'Gateway',
      start: 0,
      end: 80,
      text: 'Kong Gateway terminates TLS for tenant exports and forwards scoped JWTs.',
    },
    {
      id: 'SRC-0002',
      heading: 'Network',
      start: 81,
      end: 160,
      text: 'ExportWorker runs in a private subnet. Only the queue can invoke its job handler.',
    },
  ],
  extraction: { attempted: ['SRC-0001', 'SRC-0002'], failed: [], mode: 'full' },
}

const finding = {
  component: 'Kong Gateway',
  title: 'JWT validation bypass',
  description: 'An attacker forges a token at Kong Gateway.',
  confidenceScore: 0.92,
  disposition: 'applicable' as const,
  evidenceSources: [] as EvidenceSource[],
}

describe('citation integrity', () => {
  it('does not erase verification for a different evidence domain', () => {
    const verifiedRag: EvidenceSource = { sourceType: 'rag', sourceName: 'RAG-012345678901234567890123', excerpt: 'Reference text', referenceStatus: 'verified', supportStatus: 'unlinked' }
    expect(verifyEvidenceSource(verifiedRag, finding, { source })).toEqual(verifiedRag)
    const verifiedArchitecture: EvidenceSource = { sourceType: 'architecture', sourceName: 'SRC-0001', excerpt: 'Original text', referenceStatus: 'verified', supportStatus: 'supports' }
    expect(verifyEvidenceSource(verifiedArchitecture, finding, { passages: [] })).toEqual(verifiedArchitecture)
    // Supplying the applicable empty catalog still rejects an invented RAG ID.
    expect(verifyEvidenceSource(verifiedRag, finding, { passages: [] }).referenceStatus).toBe('unverified')
  })

  it('resolves a valid passage ID even when the model reconstructed the excerpt', () => {
    const checked = applyCitationIntegrity({
      ...finding,
      evidenceSources: [{
        sourceType: 'architecture',
        sourceName: 'SRC-0001',
        excerpt: 'Kong Gateway has no authentication whatsoever.',
      }],
    }, { source })
    expect(checked.evidenceSources[0]).toMatchObject({
      referenceStatus: 'verified',
      passageId: 'SRC-0001',
    })
    expect(checked.evidenceSources[0]?.excerpt).toContain('Kong Gateway terminates TLS')
  })

  it('marks a contiguous quote that does not name the component as unlinked', () => {
    const excerpt = 'ExportWorker runs in a private subnet.'
    const checked = applyCitationIntegrity({
      ...finding,
      evidenceSources: [{ sourceType: 'architecture', sourceName: 'SRC-0002', excerpt }],
    }, { source })
    expect(checked.evidenceSources[0]).toMatchObject({
      referenceStatus: 'verified',
      supportStatus: 'unlinked',
    })
    expect(checked.disposition).toBe('control_verification_needed')
  })

  it('keeps a matching architecture quotation as verified support', () => {
    const excerpt = 'Kong Gateway terminates TLS for tenant exports'
    const checked = applyCitationIntegrity({
      ...finding,
      evidenceSources: [{ sourceType: 'architecture', sourceName: 'SRC-0001', excerpt }],
    }, { source })
    expect(checked.evidenceSources[0]).toMatchObject({
      referenceStatus: 'verified',
      supportStatus: 'supports',
    })
    expect(checked.disposition).toBe('applicable')
    expect(checked.confidenceScore).toBe(0.92)
  })

  it('keeps invented RAG citations as unverified instead of deleting them', () => {
    const passage = makePassage({
      id: 'chunk-1',
      domain: 'corporate',
      source: 'roles.md',
      document: 'Kong Gateway grants are unknown. Export effective grants before assigning blast radius.',
      metadata: { sha256: 'version-1' },
    }, 'q1')
    const invented = {
      sourceType: 'rag' as const,
      sourceName: 'RAG-ffffffffffffffffffffffff',
      excerpt: 'Kong Gateway grants are unrestricted.',
    }
    const kept = verifyEvidenceSource(invented, finding, { passages: [passage] })
    expect(kept.referenceStatus).toBe('unverified')
    expect(kept.supportStatus).toBe('unlinked')
    expect(kept.excerpt).toBe(invented.excerpt)
    const validated = validateEvidenceSources([invented], [passage])
    expect(validated.rejected).toBe(1)
    expect(validated.sources).toHaveLength(1)
    expect(validated.sources[0]?.referenceStatus).toBe('unverified')
  })

  it('links a verified RAG quotation that names the component', () => {
    const passage = makePassage({
      id: 'chunk-1',
      domain: 'corporate',
      source: 'roles.md',
      document: 'Kong Gateway grants are unknown. Export effective grants before assigning blast radius.',
      metadata: { sha256: 'version-1' },
    }, 'q1')
    const checked = applyCitationIntegrity({
      ...finding,
      evidenceSources: [{
        sourceType: 'rag',
        sourceName: passage.citationId,
        excerpt: 'Kong Gateway grants are unknown.',
      }],
    }, { passages: [passage] })
    expect(checked.evidenceSources[0]).toMatchObject({
      referenceStatus: 'verified',
      supportStatus: 'supports',
      sourceName: 'roles.md',
    })
    expect(checked.evidenceSources[0]?.excerpt).toContain('Kong Gateway grants are unknown')
  })

  it('anchors compound component paths and source prose that omits a type suffix', () => {
    const approvalSource: SourceEvidence = {
      version: 1,
      sections: [{
        id: 'SRC-0001', heading: 'Procurement flow', start: 0, end: 160,
        text: 'The Procurement Agent routes high-value purchase orders to the Human Approver queue. External APIs include Supplier, Carrier, and Weather.',
      }],
      extraction: { attempted: ['SRC-0001'], failed: [], mode: 'full' },
    }
    const compound = applyCitationIntegrity({
      ...finding,
      component: 'Procurement Agent / Human Approver Queue',
      title: 'Agent-mediated financial threshold gaming',
      description: 'An attacker manipulates Procurement Agent threshold evaluation so high-value purchase orders bypass the Human Approver Queue.',
      evidenceSources: [{ sourceType: 'architecture' as const, sourceName: 'SRC-0001', excerpt: 'model excerpt' }],
    }, { source: approvalSource })
    expect(compound.evidenceSources[0]).toMatchObject({ referenceStatus: 'verified', supportStatus: 'supports' })

    const supplier = applyCitationIntegrity({
      ...finding,
      component: 'Supplier API',
      title: 'Unverified external financial commitment channel',
      description: 'External purchase orders reach Supplier API and expose a financial commitment channel if identity controls are weak.',
      evidenceSources: [{ sourceType: 'architecture' as const, sourceName: 'SRC-0001', excerpt: 'model excerpt' }],
    }, { source: approvalSource })
    expect(supplier.evidenceSources[0]).toMatchObject({ referenceStatus: 'verified', supportStatus: 'supports' })

    const ampersandPath = applyCitationIntegrity({
      ...finding,
      component: 'Procurement Agent & Human Approver; External APIs (Supplier, Carrier)',
      title: 'Financial approval path manipulation',
      description: 'The Procurement Agent routes high-value purchase orders to the Human Approver through External APIs for Supplier and Carrier.',
      evidenceSources: [{ sourceType: 'architecture' as const, sourceName: 'SRC-0001', excerpt: 'model excerpt' }],
    }, { source: approvalSource })
    expect(ampersandPath.evidenceSources[0]).toMatchObject({ referenceStatus: 'verified', supportStatus: 'supports' })

    const inventedEndpoint = applyCitationIntegrity({
      ...finding,
      component: 'Procurement Agent & Logging Infrastructure',
      title: 'Financial approval path manipulation',
      description: 'The Procurement Agent routes high-value purchase orders while an undocumented logging service changes the decision.',
      evidenceSources: [{ sourceType: 'architecture' as const, sourceName: 'SRC-0001', excerpt: 'model excerpt' }],
    }, { source: approvalSource })
    expect(inventedEndpoint.evidenceSources[0]).toMatchObject({ referenceStatus: 'verified', supportStatus: 'unlinked' })
  })
})
