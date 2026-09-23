import type { EvidenceSource } from '@/lib/db/schema'
import type { SourceEvidence } from '@/lib/architecture/source-evidence'
import {
  buildPassageCatalog,
  passageById,
  type PassageCatalog,
} from '@/lib/architecture/passage-catalog'
import { assessPassageRelevance } from '@/lib/evaluation/relevance'
import type { EvidencePassage } from '@/lib/rag/evidence'

type Passage = {
  citationId: string
  excerpt: string
  source: string
  queryId: string
  chunkId: string
  version: string
  domain?: EvidenceSource['domain']
  metadata: Record<string, unknown>
}

const MISSING_ANCHOR =
  'Original architecture quotations require verification: one or more excerpts could not be matched to their source, or no architecture quotation was supplied.'

export type FindingAnchor = {
  component: string
  description?: string
  title?: string
  scenario?: string
}

function passageIdOf(evidence: EvidenceSource): string | undefined {
  return evidence.passageId
    ?? evidence.citationId
    ?? evidence.sourceName.match(/SRC-\d+|RAG-[a-f0-9]{24}/)?.[0]
}

function catalogFrom(options: {
  source?: SourceEvidence | undefined
  passages?: Passage[] | undefined
}): PassageCatalog {
  return buildPassageCatalog(options.source, options.passages as EvidencePassage[] | undefined)
}

function resolveFromCatalog(
  evidence: EvidenceSource,
  finding: FindingAnchor,
  catalog: PassageCatalog,
): EvidenceSource {
  const id = passageIdOf(evidence)
  const passage = id ? passageById(catalog, id) : undefined
  if (!passage) {
    return {
      ...evidence,
      ...(id ? { passageId: id } : {}),
      referenceStatus: 'unverified',
      supportStatus: 'unlinked',
      relevanceStatus: 'insufficient',
    }
  }
  const relevance = assessPassageRelevance({
    component: finding.component,
    passage,
    ...(finding.scenario ? { scenario: finding.scenario } : {}),
    ...((finding.description ?? finding.title)
      ? { description: [finding.title, finding.description].filter(Boolean).join(' ') }
      : {}),
  })
  const expectedKind = evidence.sourceType === 'rag' ? 'rag' : 'architecture'
  if (passage.kind !== expectedKind && evidence.sourceType !== 'debate') {
    return {
      ...evidence,
      passageId: passage.id,
      citationId: passage.id,
      excerpt: passage.text,
      sourceName: passage.kind === 'architecture' ? `${passage.id} · ${passage.section}` : passage.section,
      contentFingerprint: passage.fingerprint,
      ...(passage.sourceVersion ? { sourceVersion: passage.sourceVersion } : {}),
      ...(passage.queryId ? { queryId: passage.queryId } : {}),
      ...(passage.chunkId ? { chunkId: passage.chunkId } : {}),
      ...(passage.domain ? { domain: passage.domain } : {}),
      referenceStatus: 'unverified',
      supportStatus: 'unlinked',
      relevanceStatus: 'not_relevant',
    }
  }
  return {
    ...evidence,
    passageId: passage.id,
    citationId: passage.id,
    excerpt: passage.text,
    sourceName: passage.kind === 'architecture' ? `${passage.id} · ${passage.section}` : passage.section,
    contentFingerprint: passage.fingerprint,
    ...(passage.sourceVersion ? { sourceVersion: passage.sourceVersion } : {}),
    ...(passage.queryId ? { queryId: passage.queryId } : {}),
    ...(passage.chunkId ? { chunkId: passage.chunkId } : {}),
    ...(passage.domain ? { domain: passage.domain } : {}),
    referenceStatus: 'verified',
    supportStatus: relevance === 'relevant' ? 'supports' : 'unlinked',
    relevanceStatus: relevance,
  }
}

export function verifyEvidenceSource(
  evidence: EvidenceSource,
  finding: FindingAnchor,
  options: { source?: SourceEvidence | undefined; passages?: Passage[] | undefined } = {},
): EvidenceSource {
  if (evidence.sourceType !== 'rag' && evidence.sourceType !== 'architecture') return evidence
  // Validate only against the authoritative catalog supplied for this domain.
  // The architecture pass must not erase a RAG verification, or vice versa.
  if (evidence.sourceType === 'architecture' && !options.source) return evidence
  if (evidence.sourceType === 'rag' && !options.passages) return evidence
  return resolveFromCatalog(evidence, finding, catalogFrom(options))
}

export function applyCitationIntegrity<T extends FindingAnchor & {
  confidenceScore: number
  evidenceSources: EvidenceSource[]
}>(threat: T, options: { source?: SourceEvidence | undefined; passages?: Passage[] | undefined } = {}): Omit<T, 'evidenceSources'> & { evidenceSources: EvidenceSource[] } {
  const evidenceSources = threat.evidenceSources.map((evidence) =>
    verifyEvidenceSource(evidence, threat, options))
  const verifiedSupport = evidenceSources.some((evidence) =>
    evidence.sourceType === 'architecture'
    && evidence.referenceStatus === 'verified'
    && evidence.supportStatus === 'supports')
  if (verifiedSupport || !options.source) return { ...threat, evidenceSources }
  const anchorNote = evidenceSources.some(evidence => evidence.sourceType === 'architecture' && evidence.referenceStatus === 'verified')
    ? 'Original architecture references resolve, but their support for this finding remains unestablished. Verify the claim before treating it as confirmed.'
    : MISSING_ANCHOR
  const prior = threat as T & { preconditions?: string[] | undefined; reasoning?: string | null | undefined }
  return {
    ...threat,
    evidenceSources,
    confidenceScore: Math.min(threat.confidenceScore, 0.69),
    disposition: 'control_verification_needed',
    preconditions: [...new Set([...(prior.preconditions ?? []), anchorNote])],
    reasoning: [prior.reasoning, anchorNote].filter(Boolean).join(' '),
  } as Omit<T, 'evidenceSources'> & { evidenceSources: EvidenceSource[] }
}
