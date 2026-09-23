/**
 * Section-aware splitting for oversized architecture input.
 *
 * The API accepts up to 500,000 string code units of architecture text.
 * Section extraction bounds each request; downstream summaries and evidence
 * budgets still limit retained information. Processing every chunk does not
 * establish complete semantic coverage (see docs/CONTEXT_AND_COVERAGE.md).
 *
 * Splitting prefers real document structure (Markdown headings), then
 * paragraphs, and only then a hard character window, so a section's facts stay
 * together in one pass.
 */

/** Chars, not tokens: ~4 chars/token, sized for the smallest supported window. */
export const DEFAULT_CHUNK_CHARS = 14_000

/** Below this, a single pass is used and nothing is split. */
export const SINGLE_PASS_LIMIT = 18_000

/** Hosted providers can safely process a few independent sections at once. */
export const DEFAULT_REMOTE_CHUNK_CONCURRENCY = 3

/**
 * Keep local inference serialized while allowing bounded cloud fan-out.
 * The optional override is deliberately capped by the number of chunks.
 */
export function resolveArchitectureChunkConcurrency(
  provider: string,
  chunkCount: number,
  configured?: number | undefined,
): number {
  if (chunkCount <= 1 || provider === 'ollama') return 1
  const requested = typeof configured === 'number' && Number.isInteger(configured) && configured > 0
    ? configured
    // Kimi showed head-of-line stalls when three long-context sections were
    // opened together. Two still keeps a 14-section document comfortably
    // inside the phase budget without saturating the provider connection.
    : provider === 'kimi' ? 2 : DEFAULT_REMOTE_CHUNK_CONCURRENCY
  return Math.max(1, Math.min(chunkCount, requested))
}

const HEADING = /^#{1,6}\s+\S/

export type InputChunk = {
  index: number
  /** Heading path this chunk belongs to, for prompt context. */
  heading: string
  text: string
}

function splitOversizedBlock(block: string, limit: number): string[] {
  if (block.length <= limit) return [block]
  const paragraphs = block.split(/\n{2,}/)
  const out: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      if (current) {
        out.push(current)
        current = ''
      }
      for (let i = 0; i < paragraph.length; i += limit) {
        out.push(paragraph.slice(i, i + limit))
      }
      continue
    }
    if (current.length + paragraph.length + 2 > limit) {
      out.push(current)
      current = paragraph
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph
    }
  }
  if (current) out.push(current)
  return out
}

/**
 * Split into ordered chunks. Returns a single chunk when the input already fits,
 * so the common case pays nothing.
 */
export function chunkArchitectureInput(
  input: string,
  options: { chunkChars?: number | undefined; singlePassLimit?: number | undefined } = {},
): InputChunk[] {
  const text = input.trim()
  const limit = options.chunkChars ?? DEFAULT_CHUNK_CHARS
  const singlePass = options.singlePassLimit ?? SINGLE_PASS_LIMIT
  if (text.length <= singlePass) {
    return [{ index: 0, heading: '', text }]
  }

  // Group lines into heading-led sections first.
  const sections: Array<{ heading: string; body: string[] }> = []
  let currentHeading = ''
  let body: string[] = []
  const flush = () => {
    if (body.length === 0) return
    sections.push({ heading: currentHeading, body })
    body = []
  }
  for (const line of text.split('\n')) {
    if (HEADING.test(line)) {
      flush()
      currentHeading = line.replace(/^#{1,6}\s+/, '').trim().slice(0, 120)
      body = []
      continue
    }
    body.push(line)
  }
  flush()

  const blocks =
    sections.length > 0
      ? sections
      : [{ heading: '', body: text.split('\n') }]

  // Pack sections up to the limit, splitting any single oversized section.
  const chunks: InputChunk[] = []
  let pending: { heading: string; text: string } | null = null
  const push = (heading: string, chunkText: string) => {
    const trimmed = chunkText.trim()
    if (!trimmed) return
    chunks.push({ index: chunks.length, heading, text: trimmed })
  }

  for (const section of blocks) {
    const sectionText = [section.heading ? `## ${section.heading}` : '', ...section.body]
      .filter((line) => line !== '')
      .join('\n')
    for (const piece of splitOversizedBlock(sectionText, limit)) {
      if (!pending) {
        pending = { heading: section.heading, text: piece }
        continue
      }
      if (pending.text.length + piece.length + 2 <= limit) {
        pending = { heading: pending.heading || section.heading, text: `${pending.text}\n\n${piece}` }
      } else {
        push(pending.heading, pending.text)
        pending = { heading: section.heading, text: piece }
      }
    }
  }
  if (pending) push(pending.heading, pending.text)

  return chunks.length > 0 ? chunks : [{ index: 0, heading: '', text }]
}

type Named = { name: string }

function dedupeByName<T extends Named>(items: T[]): T[] {
  const byKey = new Map<string, T>()
  for (const item of items) {
    const key = item.name.trim().toLowerCase()
    if (!key) continue
    const existing = byKey.get(key)
    // Prefer the richer record (more populated fields) when a name repeats.
    if (!existing || Object.values(item).filter(Boolean).length > Object.values(existing).filter(Boolean).length) {
      byKey.set(key, item)
    }
  }
  return [...byKey.values()]
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(value.trim())
  }
  return out
}

export type PartialArchitecture = {
  systemDescription?: string | undefined
  components?: Array<{ name: string; type: string; scope: string; technology?: string | undefined; relationship?: 'system' | 'dependency' | 'investigated' | 'adjacent' | 'proposed' | 'historical'; scopeEvidence?: string | undefined }> | undefined
  dataFlows?: Array<{ from: string; to: string; data: string; protocol?: string | undefined }> | undefined
  trustBoundaries?: string[] | undefined
  externalEntities?: string[] | undefined
  dataStores?: string[] | undefined
  apiEndpoints?: string[] | undefined
  deploymentInfo?: string | undefined
  techFlags?: Record<string, boolean> | undefined
  detailedTopology?:
    | {
        actors?: Array<{ name: string; description: string; privilegeLevel: string; reference?: string | undefined }> | undefined
        environmentVars?: Array<{ name: string; value?: string | undefined; isSensitive: boolean; component: string }> | undefined
        securityConfigs?: Array<{ component: string; configType: string; isEnabled: boolean; details: string }> | undefined
      }
    | undefined
}

/**
 * Merge per-chunk extractions deterministically. No model call: unions and
 * name-keyed dedupe, so the same chunks always produce the same architecture.
 * Tech flags are OR-ed — a flag is true if any section evidenced it.
 */
export function mergePartialArchitectures(parts: PartialArchitecture[]): PartialArchitecture {
  const flags: Record<string, boolean> = {}
  for (const part of parts) {
    for (const [key, value] of Object.entries(part.techFlags ?? {})) {
      flags[key] = Boolean(flags[key]) || Boolean(value)
    }
  }

  const flowKey = (f: { from: string; to: string; data: string }) =>
    `${f.from}→${f.to}:${f.data}`.toLowerCase()
  const flows = new Map<string, NonNullable<PartialArchitecture['dataFlows']>[number]>()
  for (const part of parts) {
    for (const flow of part.dataFlows ?? []) {
      if (!flows.has(flowKey(flow))) flows.set(flowKey(flow), flow)
    }
  }

  const configKey = (c: { component: string; configType: string; details: string }) =>
    `${c.component}|${c.configType}|${c.details}`.toLowerCase()
  const configs = new Map<string, NonNullable<NonNullable<PartialArchitecture['detailedTopology']>['securityConfigs']>[number]>()
  for (const part of parts) {
    for (const config of part.detailedTopology?.securityConfigs ?? []) {
      if (!configs.has(configKey(config))) configs.set(configKey(config), config)
    }
  }

  return {
    systemDescription: parts
      .map((part) => part.systemDescription?.trim())
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .slice(0, 2_000),
    components: dedupeByName(parts.flatMap((part) => part.components ?? [])),
    dataFlows: [...flows.values()],
    trustBoundaries: dedupeStrings(parts.flatMap((part) => part.trustBoundaries ?? [])),
    externalEntities: dedupeStrings(parts.flatMap((part) => part.externalEntities ?? [])),
    dataStores: dedupeStrings(parts.flatMap((part) => part.dataStores ?? [])),
    apiEndpoints: dedupeStrings(parts.flatMap((part) => part.apiEndpoints ?? [])),
    deploymentInfo: dedupeStrings(
      parts.map((part) => part.deploymentInfo ?? '').filter(Boolean),
    ).join(' ').slice(0, 1_000),
    techFlags: flags,
    detailedTopology: {
      actors: dedupeByName(parts.flatMap((part) => part.detailedTopology?.actors ?? [])),
      environmentVars: dedupeByName(parts.flatMap((part) => part.detailedTopology?.environmentVars ?? [])),
      securityConfigs: [...configs.values()],
    },
  }
}
