import { createHash } from 'node:crypto'
import type { SourceEvidence, SourceSection } from '@/lib/architecture/source-evidence'
import type { EvidencePassage } from '@/lib/rag/evidence'

export const PASSAGE_CATALOG_VERSION = 1

export type CanonicalPassage = {
  id: string
  kind: 'architecture' | 'rag'
  section: string
  start: number
  end: number
  fingerprint: string
  text: string
  relatedIds: string[]
  sourceVersion?: string
  queryId?: string
  chunkId?: string
  domain?: EvidencePassage['domain']
}

export type PassageCatalog = {
  version: typeof PASSAGE_CATALOG_VERSION
  passages: CanonicalPassage[]
}

export function contentFingerprint(text: string): string {
  return createHash('sha256').update(text.normalize('NFC')).digest('hex').slice(0, 16)
}

export function architecturePassages(source: SourceEvidence): CanonicalPassage[] {
  return source.sections.map((section, index) => ({
    id: section.id,
    kind: 'architecture' as const,
    section: section.heading,
    start: section.start,
    end: section.end,
    fingerprint: section.fingerprint ?? contentFingerprint(section.text),
    text: section.text,
    relatedIds: relatedSectionIds(source.sections, index),
  }))
}

export function ragPassages(passages: EvidencePassage[]): CanonicalPassage[] {
  return passages.map((passage) => ({
    id: passage.citationId,
    kind: 'rag' as const,
    section: passage.source,
    start: 0,
    end: passage.excerpt.length,
    fingerprint: contentFingerprint(passage.excerpt),
    text: passage.excerpt,
    relatedIds: [],
    sourceVersion: passage.version,
    queryId: passage.queryId,
    chunkId: passage.chunkId,
    domain: passage.domain,
  }))
}

export function buildPassageCatalog(
  source?: SourceEvidence,
  passages: EvidencePassage[] = [],
): PassageCatalog {
  const items = [
    ...(source ? architecturePassages(source) : []),
    ...ragPassages(passages),
  ]
  return { version: PASSAGE_CATALOG_VERSION, passages: items }
}

export function passageById(catalog: PassageCatalog, id: string): CanonicalPassage | undefined {
  const normalized = id.trim()
  return catalog.passages.find((passage) => passage.id === normalized)
}

export function formatCatalogForPrompt(catalog: PassageCatalog): string {
  return catalog.passages.map((passage) => (
    `[${passage.id}] fingerprint=${passage.fingerprint} ${passage.kind} ${passage.section} offsets ${passage.start}–${passage.end}\n${passage.text}\n[/${passage.id}]`
  )).join('\n\n')
}

function relatedSectionIds(sections: SourceSection[], index: number): string[] {
  return [sections[index - 1]?.id, sections[index + 1]?.id].filter((id): id is string => Boolean(id))
}
