import { createHash } from 'node:crypto'

export type DocumentMetadata = Record<string, string>
const FIELDS = new Set(['doc_id', 'title', 'entity', 'system', 'system_id', 'environment', 'as_of', 'effective_at', 'doc_type', 'source_scope', 'assertion_type', 'sensitivity', 'aliases', 'supersedes'])

/** Preserve source declarations as untrusted metadata, never as verified facts. */
export function parseDocument(text: string): { body: string; metadata: DocumentMetadata; qualification: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (/^\s*\{\\rtf\d/i.test(normalized)) {
    throw new Error('RTF content is not plain text. Export this document as UTF-8 text or Markdown before indexing.')
  }
  const frontmatter = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
  const metadata: DocumentMetadata = {}
  if (frontmatter) {
    for (const line of frontmatter[1]!.split('\n')) {
      const match = line.match(/^([a-z_]+):\s*(.+)$/i)
      if (match && FIELDS.has(match[1]!)) metadata[match[1]!] = match[2]!.trim().replace(/^['"]|['"]$/g, '').slice(0, 500)
    }
  }
  const body = normalized.slice(frontmatter?.[0].length ?? 0).trim()
  // Document-level introductory qualifications must accompany later sections.
  const introduction = body.split(/^##\s/m)[0] ?? ''
  const qualification = introduction.split(/\n\s*\n/).filter(p => /\b(inferred|disputed|unconfirmed|unknown|planned)\b|análisis derivado|no es una declaración|controls unknown/i.test(p)).join('\n\n').slice(0, 1200)
  return { body, metadata, qualification }
}

export type DocumentSection = {
  text: string
  sectionPath: string
  start: number
  end: number
  metadata: DocumentMetadata
  qualification: string
  structureContext?: string
}

type MarkdownBlock = { start: number; end: number; context: string }

function markdownStructure(body: string): { blocks: MarkdownBlock[]; headings: Array<{ index: number; path: string }> } {
  const lines = [...body.matchAll(/[^\n]*(?:\n|$)/g)].filter(line => line[0].length)
  const blocks: MarkdownBlock[] = []
  const headings: Array<{ index: number; path: string }> = []
  const stack: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = line[0].match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      const opening = i
      const marker = fence[1]!
      while (++i < lines.length) {
        const close = lines[i]![0].trim()
        if (close.length >= marker.length && [...close].every(char => char === marker[0])) break
      }
      const last = lines[Math.min(i, lines.length - 1)]!
      blocks.push({ start: line.index, end: last.index + last[0].length, context: lines[opening]![0].trim() })
      continue
    }
    if (line[0].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]?.[0] ?? '')) {
      const header = line[0] + lines[i + 1]![0]
      i++
      while (i + 1 < lines.length && lines[i + 1]![0].includes('|') && lines[i + 1]![0].trim()) i++
      const last = lines[i]!
      blocks.push({ start: line.index, end: last.index + last[0].length, context: header.trim() })
      continue
    }
    const heading = line[0].match(/^(#{1,6})\s+(.+)/)
    if (heading) {
      stack.length = heading[1]!.length - 1
      stack.push(heading[2]!.trim())
      headings.push({ index: line.index, path: stack.filter(Boolean).join(' > ') })
    }
  }
  return { blocks, headings }
}

/** Verify exact source spans and coverage of every non-whitespace body character. */
export function assertSectionCoverage(body: string, sections: DocumentSection[]): void {
  let covered = 0
  for (const section of sections) {
    if (section.start < 0 || section.end <= section.start || section.end > body.length
      || section.text !== body.slice(section.start, section.end).trim()) throw new Error('Chunk does not match its source span')
    if (section.start > covered && body.slice(covered, section.start).trim()) throw new Error('Chunk coverage gap')
    covered = Math.max(covered, section.end)
  }
  if (body.slice(covered).trim()) throw new Error('Chunk coverage is incomplete')
}

/** Deterministic source spans in normalized body UTF-16 offsets, not byte offsets. */
export function documentSections(text: string, size = 1800, overlap = 120): DocumentSection[] {
  if (!Number.isInteger(size) || size < 200 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size) throw new Error('Invalid chunk size or overlap')
  const { body, metadata, qualification } = parseDocument(text)
  const { blocks, headings } = markdownStructure(body)
  const boundaries = [...new Set([0, ...headings.map(h => h.index), body.length])].sort((a, b) => a - b)
  const sections: DocumentSection[] = []
  let headingIndex = -1
  let blockIndex = 0
  for (let i = 0; i < boundaries.length - 1; i++) {
    const begin = boundaries[i]!, end = boundaries[i + 1]!
    while (headingIndex + 1 < headings.length && headings[headingIndex + 1]!.index <= begin) headingIndex++
    const sectionPath = headings[headingIndex]?.path ?? metadata.title ?? 'Document'
    for (let start = begin; start < end;) {
      while (blockIndex < blocks.length && blocks[blockIndex]!.end <= start) blockIndex++
      let stop = Math.min(end, start + size)
      if (stop < end) {
        const prefix = body.slice(start, stop)
        const boundary = Math.max(prefix.lastIndexOf('\n\n'), prefix.lastIndexOf('. ') + 1, prefix.lastIndexOf('\n'))
        if (boundary > size * 0.55) stop = start + boundary
        // Keep a fitting table or fenced block intact. Large blocks split at
        // source line boundaries and carry their header/opening as context.
        for (let b = blockIndex; b < blocks.length && blocks[b]!.start < stop; b++) {
          const block = blocks[b]!
          if (stop < block.end && block.end - block.start <= size) stop = block.start > start ? block.start : block.end
        }
        if (stop < body.length && /[\uD800-\uDBFF]/.test(body[stop - 1]!)) stop--
      }
      const chunk = body.slice(start, stop).trim()
      const block = blocks[blockIndex]
      const structureContext = block && start >= block.start && start < block.end ? block.context : ''
      if (chunk) sections.push({ text: chunk, sectionPath, start, end: stop, metadata, qualification, structureContext })
      if (stop === end) break
      let next = Math.max(start + 1, stop - Math.min(overlap, Math.floor(size / 4)))
      const containing = blocks.find(block => block.start < next && block.end > next && block.end - block.start <= size)
      if (containing) next = containing.start > start ? containing.start : containing.end
      if (next > 0 && /[\uDC00-\uDFFF]/.test(body[next]!)) next--
      start = Math.max(start + 1, next)
    }
  }
  assertSectionCoverage(body, sections)
  return sections
}

export function documentVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function metadataContext(metadata: Record<string, unknown>): string {
  return [...FIELDS].flatMap(key => typeof metadata[key] === 'string' ? [`${key}: ${metadata[key]}`] : []).join('\n')
}
