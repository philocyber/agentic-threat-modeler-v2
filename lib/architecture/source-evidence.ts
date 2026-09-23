import { createHash } from 'node:crypto'
import type { ArchitectureData, RawThreat } from '@/lib/models/types'
import { applyCitationIntegrity } from '@/lib/evaluation/citation-integrity'
import { redactSecretsInText } from '@/lib/utils/redact'

export class SourceCoverageError extends Error {
  readonly code = 'SOURCE_COVERAGE_INCOMPLETE'
  constructor(message: string) { super(message); this.name = 'SourceCoverageError' }
}

export type SourceSection = {
  id: string
  heading: string
  start: number
  end: number
  text: string
  fingerprint?: string | undefined
}
export type SourceEvidence = {
  version: 1
  sections: SourceSection[]
  extraction: { attempted: string[]; failed: string[]; mode: 'full' | 'sectioned' }
  /** Delivery is observable; semantic understanding is not certified. */
  analystDelivery?: Record<string, string[]>
}

type ContextModel = { contextWindow?: number; outputTokenReserve?: number; countTextTokens?: (text: string) => number }

export function sourceSectionsFit(model: unknown, sections: SourceSection[], overheadCharacters: number): boolean {
  const capacity = (model ?? {}) as ContextModel
  if (!capacity.countTextTokens) return formatSourceSections(sections).length <= sourceCharacterBudget(model, overheadCharacters)
  const window = capacity.contextWindow ?? 32_768
  const reserve = capacity.outputTokenReserve ?? Math.min(8_192, Math.floor(window / 4))
  // Retain a conservative allowance for the other prompt blocks and framing.
  return capacity.countTextTokens(formatSourceSections(sections)) + Math.ceil(overheadCharacters / 2.5) + reserve + 1024 <= window
}

export function sourceNotesCharacterBudget(model: unknown, input: string, systemPrompt: string): number {
  const capacity = (model ?? {}) as ContextModel
  if (!capacity.countTextTokens) return Math.max(2_000, Math.min(32_000, Math.floor(sourceCharacterBudget(model, input.length + 12_000) / 2)))
  const window = capacity.contextWindow ?? 32_768
  const reserve = capacity.outputTokenReserve ?? Math.min(8_192, Math.floor(window / 4))
  // Leave room for selective RAG passages, framing, and both prompt envelopes.
  const remaining = window - reserve - 1024 - 4000
    - capacity.countTextTokens(input) - capacity.countTextTokens(systemPrompt)
  if (remaining < 800) throw new SourceCoverageError('Source coverage blocked: the full evidence leaves insufficient room for complete review notes.')
  return Math.min(32_000, Math.floor(remaining * 2.5))
}

/** Deliberately conservative fallback, not a claim about a vendor's advertised window. */
export function sourceCharacterBudget(model?: unknown, overheadCharacters = 20_000): number {
  const capacity = (model ?? {}) as ContextModel
  const window = capacity.contextWindow ?? 32_768
  const reserve = capacity.outputTokenReserve ?? Math.min(8_192, Math.floor(window / 4))
  // Approximately 2.5 characters/token is conservative for typical prose/code;
  // the final provider guard still rejects overflow. This is not a tokenizer.
  return Math.max(0, Math.floor((window - reserve) * 2.5) - overheadCharacters)
}

/** Keep every character (after secret redaction), including headings and qualifications. */
export function createSourceEvidence(input: string): SourceEvidence {
  const text = redactSecretsInText(input)
  const sections: SourceSection[] = []
  let start = 0
  let heading = 'Source input'
  while (start < text.length) {
    const nextHeading = /\n(?=#{1,6}\s)/g
    nextHeading.lastIndex = start + 1
    const boundary = nextHeading.exec(text)?.index
    let end = Math.min(start + 3_000, text.length, boundary === undefined ? text.length : boundary + 1)
    if (end < text.length && end === start + 3_000) {
      const paragraph = text.lastIndexOf('\n\n', end)
      if (paragraph > start + 1_000) end = paragraph + 2
    }
    const body = text.slice(start, end)
    heading = body.match(/^\s*(#{1,6})\s+([^\n]+)/)?.[2]?.trim() ?? heading
    const id = `SRC-${String(sections.length + 1).padStart(4, '0')}`
    sections.push({
      id,
      heading,
      start,
      end,
      text: body,
      fingerprint: createHash('sha256').update(body.normalize('NFC')).digest('hex').slice(0, 16),
    })
    start = end
  }
  return { version: 1, sections, extraction: { attempted: [], failed: [], mode: 'sectioned' } }
}

export function formatSourceSections(sections: SourceSection[]): string {
  return sections.map(s => {
    const fingerprint = s.fingerprint ?? createHash('sha256').update(s.text.normalize('NFC')).digest('hex').slice(0, 16)
    return `[${s.id}] fingerprint=${fingerprint} ${s.heading} (source offsets ${s.start}–${s.end})\n${s.text}\n[/${s.id}]`
  }).join('\n\n')
}

export function packSourceSections(sections: SourceSection[], budget: number): SourceSection[][] {
  const packets: SourceSection[][] = []
  let current: SourceSection[] = []
  for (const section of sections) {
    if (formatSourceSections([section]).length > budget) throw new SourceCoverageError('Source coverage blocked: a complete source section exceeds the available model context. Increase the configured context or reduce prompt overhead.')
    if (current.length && formatSourceSections([...current, section]).length > budget) {
      packets.push(current)
      current = []
    }
    current.push(section)
  }
  if (current.length) packets.push(current)
  return packets
}

/** Exact source IDs first, then all matching sections, including contradictory qualifications. */
export function retrieveSourceSections(source: SourceEvidence, query: string): SourceSection[] {
  const ids = new Set(query.match(/SRC-\d+/g) ?? [])
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_/-]{3,}/gu) ?? [])]
    .filter(t => !['the', 'and', 'for', 'with', 'from', 'this', 'that', 'source', 'component'].includes(t))
  const ranked = source.sections.map(s => ({
    section: s,
    score: (ids.has(s.id) ? 10_000 : 0) + terms.filter(t => `${s.heading}\n${s.text}`.toLowerCase().includes(t)).length,
  })).filter(s => s.score > 0).sort((a, b) => b.score - a.score || a.section.start - b.section.start)
  // Include adjacent windows so a match near a hard boundary retains qualifications.
  const selected = new Set(ranked.flatMap(({ section }) => {
    const i = source.sections.indexOf(section)
    return [source.sections[i - 1], section, source.sections[i + 1]].filter((s): s is SourceSection => Boolean(s))
  }))
  return source.sections.filter(s => selected.has(s))
}

export function sourceLookup(architecture: ArchitectureData, model?: unknown): ((query: string) => string) | undefined {
  if (!architecture.sourceEvidence) return undefined
  const source = architecture.sourceEvidence
  return query => {
    const selected = retrieveSourceSections(source, query)
    if (!selected.length) return 'No source section matched. This is unresolved evidence, not proof of absence.'
    const text = formatSourceSections(selected)
    if (text.length > sourceCharacterBudget(model)) throw new SourceCoverageError('Source coverage blocked: requested cross-document evidence exceeds context; no passages were silently omitted.')
    return text
  }
}

export function assertExtractionCoverage(architecture: ArchitectureData): void {
  const source = architecture.sourceEvidence
  if (!source) return // Historical runs do not acquire fabricated coverage.
  const attempted = new Set(source.extraction.attempted)
  if (source.extraction.failed.length || source.sections.some(s => !attempted.has(s.id))) {
    throw new SourceCoverageError(`Source coverage blocked: ${source.extraction.failed.length} failed sections or unattempted source sections. Architecture was saved; resolve extraction before paying for analysis.`)
  }
}

export function assertAnalystCoverage(architecture: ArchitectureData, analysts: string[]): void {
  assertExtractionCoverage(architecture)
  const source = architecture.sourceEvidence
  if (!source) return
  for (const analyst of analysts) {
    const delivered = new Set(source.analystDelivery?.[analyst] ?? [])
    if (source.sections.some(s => !delivered.has(s.id))) throw new SourceCoverageError(`Source coverage blocked before debate: ${analyst} did not successfully process every source section.`)
  }
}

/** Restore original evidence before a decision, not just an earlier agent's paraphrase. */
export function architectureForFindings(
  architecture: ArchitectureData,
  findings: Array<{ component: string; evidenceSources?: Array<{ sourceName: string; excerpt: string }> }>,
  model?: unknown,
): ArchitectureData {
  const source = architecture.sourceEvidence
  if (!source) return architecture
  if (sourceSectionsFit(model, source.sections, 24_000)) return architecture
  const ids = new Set<string>()
  for (const finding of findings) {
    const query = [finding.component, ...(finding.evidenceSources ?? []).flatMap(s => s.sourceName.match(/SRC-\d+/g) ?? [])].join(' ')
    for (const section of retrieveSourceSections(source, query)) ids.add(section.id)
    for (const evidence of finding.evidenceSources ?? []) {
      if (evidence.excerpt.length >= 12) {
        for (const section of source.sections) if (section.text.includes(evidence.excerpt)) ids.add(section.id)
      }
    }
  }
  const selected = source.sections.filter(s => ids.has(s.id))
  if (!selected.length || !sourceSectionsFit(model, selected, 24_000)) {
    throw new SourceCoverageError('Source coverage blocked: complete finding evidence and related qualifications cannot fit this review context.')
  }
  return { ...architecture, sourceEvidence: { ...source, sections: selected } }
}

export function hasAnalystDelivery(architecture: ArchitectureData | null | undefined, analyst: string): boolean {
  if (!architecture?.sourceEvidence) return true
  const source = architecture.sourceEvidence
  const delivered = new Set(source.analystDelivery?.[analyst] ?? [])
  return source.sections.every(section => delivered.has(section.id))
}

/** A supplied SRC label alone is not a verified quotation. */
export function verifyArchitectureAnchors(threat: RawThreat, source: SourceEvidence): RawThreat {
  return applyCitationIntegrity(threat, { source }) as RawThreat
}
