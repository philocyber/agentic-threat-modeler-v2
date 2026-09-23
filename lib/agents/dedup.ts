import { cosineSimilarity, lexicalSimilarity, type BatchEmbedFn, type EmbedFn } from '@/lib/embeddings/client'
import { agentLog, agentWarn } from './logger'
import type { RawThreat } from '@/lib/models/types'

type DedupStats = {
  inputCount: number
  afterConfidence: number
  afterEmbeddingDedup: number
  confidenceFiltered: number
  embeddingDuplicates: number
  embeddingMode: 'embedding' | 'lexical' | 'none'
  similarityThreshold: number
}

export type DedupResult = {
  kept: RawThreat[]
  filteredCount: number
  stats: DedupStats
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.88
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.55

function threatFingerprint(t: RawThreat): string {
  return `${t.component} | ${t.description.slice(0, 300)}`
}

function dedupeByLexical(threats: RawThreat[], threshold: number): { kept: RawThreat[]; dropped: number } {
  const kept: RawThreat[] = []
  let dropped = 0

  for (const threat of threats) {
    const fp = threatFingerprint(threat)
    const duplicateIdx = kept.findIndex((existing) => {
      const score = lexicalSimilarity(fp, threatFingerprint(existing))
      return sameAttackMechanism(threat, existing) || score >= threshold
    })
    if (duplicateIdx >= 0) {
      dropped++
      const existing = kept[duplicateIdx]!
      kept[duplicateIdx] = shouldKeepAsPrimary(threat, existing)
        ? mergeThreatFields(threat, existing)
        : mergeThreatFields(existing, threat)
    } else {
      kept.push(threat)
    }
  }

  return { kept, dropped }
}

// Chunk size for batched embedding calls — Ollama /api/embed accepts an array
// of inputs, so each chunk costs ONE HTTP round-trip instead of one per threat.
const EMBED_CHUNK_SIZE = 32

/**
 * Embed all fingerprints up front. With `embedBatch`, N threats cost
 * ceil(N/EMBED_CHUNK_SIZE) HTTP calls (chunks run in parallel); the legacy
 * per-text `embed` path is parallelized too. Returns null per text whose
 * embedding failed — those threats are always kept (never treated as dupes).
 * Throws when EVERY embedding failed so the caller can fall back to lexical.
 */
async function embedFingerprints(
  texts: string[],
  embedBatch?: BatchEmbedFn | undefined,
  embed?: EmbedFn | undefined,
): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = new Array<number[] | null>(texts.length).fill(null)

  if (embedBatch) {
    const chunks: Array<{ start: number; texts: string[] }> = []
    for (let i = 0; i < texts.length; i += EMBED_CHUNK_SIZE) {
      chunks.push({ start: i, texts: texts.slice(i, i + EMBED_CHUNK_SIZE) })
    }
    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const embeddings = await embedBatch(chunk.texts)
          chunk.texts.forEach((_, j) => {
            out[chunk.start + j] = embeddings[j] ?? null
          })
        } catch (err) {
          agentWarn(
            `[dedup] batch embed failed for chunk of ${chunk.texts.length}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }),
    )
  } else if (embed) {
    await Promise.all(
      texts.map(async (text, i) => {
        try {
          out[i] = await embed(text)
        } catch (err) {
          agentWarn(`[dedup] embed failed for threat, keeping: ${err instanceof Error ? err.message : String(err)}`)
        }
      }),
    )
  }

  if (texts.length > 0 && out.every((e) => e === null || e.length === 0)) {
    throw new Error('all embedding calls failed')
  }
  return out
}

/**
 * Greedy dedup over precomputed embeddings. The O(n²) cosine comparisons are
 * local CPU — cheap; the expensive part (embedding HTTP calls) happens once in
 * embedFingerprints. Order-preserving: keeps the first occurrence, merging
 * methodology fields from duplicates (higher-confidence description wins).
 */
function dedupeWithEmbeddings(
  threats: RawThreat[],
  embeddings: (number[] | null)[],
  threshold: number,
): { kept: RawThreat[]; dropped: number } {
  const kept: RawThreat[] = []
  const keptEmbeddings: number[][] = []
  let dropped = 0

  threats.forEach((threat, i) => {
    const embedding = embeddings[i]
    if (!embedding || embedding.length === 0) {
      kept.push(threat)
      keptEmbeddings.push([])
      return
    }

    const duplicateIdx = keptEmbeddings.findIndex((existing, index) => {
      if (sameAttackMechanism(threat, kept[index]!)) return true
      if (existing.length === 0) return false
      return cosineSimilarity(embedding, existing) >= threshold
    })

    if (duplicateIdx >= 0) {
      dropped++
      const winner = kept[duplicateIdx]
      if (winner) {
        const preferIncoming = shouldKeepAsPrimary(threat, winner)
        kept[duplicateIdx] = preferIncoming
          ? mergeThreatFields(threat, winner)
          : mergeThreatFields(winner, threat)
      }
    } else {
      kept.push(threat)
      keptEmbeddings.push(embedding)
    }
  })

  return { kept, dropped }
}

export function sameAttackMechanism(left: RawThreat, right: RawThreat): boolean {
  const text = (t: RawThreat) => `${t.description} ${t.attackVector ?? ''} ${t.attackTree?.rootGoal ?? ''}`
  const mechanisms = [/path traversal|directory traversal|travers(?:e|al).*?(?:path|artifact|filesystem)/i, /sql injection/i, /prompt injection/i, /cross.site scripting|\bxss\b/i]
  if (!mechanisms.some(pattern => pattern.test(text(left)) && pattern.test(text(right)))) return false
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const leftComponents = [left.component, ...(left.traceability?.components ?? [])].map(norm)
  const sameAsset = [right.component, ...(right.traceability?.components ?? [])].some(c => leftComponents.includes(norm(c)))
  const refs = (t: RawThreat) => new Set(t.evidenceSources.filter(e => e.sourceType === 'architecture').flatMap(e => e.sourceName.match(/(?:CTRL|FACT)-\d+/g) ?? []))
  const leftRefs = refs(left)
  return sameAsset && [...refs(right)].some(id => leftRefs.has(id))
}

function hasRagEvidence(threat: RawThreat): boolean {
  return threat.evidenceSources.some((source) => source.sourceType === 'rag')
}

/**
 * Keep the RAG-backed description when embedding-deduping. A slightly higher
 * ATTACK_TREE confidence used to overwrite PASTA text that actually cited the corpus.
 */
function shouldKeepAsPrimary(incoming: RawThreat, existing: RawThreat): boolean {
  const incomingRag = hasRagEvidence(incoming)
  const existingRag = hasRagEvidence(existing)
  if (incomingRag !== existingRag) return incomingRag
  return incoming.confidenceScore > existing.confidenceScore
}

/** Merge methodology-specific fields from duplicate into the kept threat. */
function mergeThreatFields(primary: RawThreat, secondary: RawThreat): RawThreat {
  return {
    ...primary,
    candidateId: primary.candidateId ?? secondary.candidateId,
    methodologies: [...new Set([
      ...(primary.methodologies ?? [primary.methodology]),
      ...(secondary.methodologies ?? [secondary.methodology]),
    ])],
    attackTree: primary.attackTree ?? secondary.attackTree,
    attackerProfile: primary.attackerProfile ?? secondary.attackerProfile,
    attackVector: primary.attackVector ?? secondary.attackVector,
    traceability: primary.traceability ?? secondary.traceability,
    reasoning: primary.reasoning ?? secondary.reasoning,
    controlReference: primary.controlReference ?? secondary.controlReference,
    evidenceSources: [...new Map(
      [...primary.evidenceSources, ...secondary.evidenceSources]
        .map((source) => [`${source.sourceType}:${source.sourceName}:${source.excerpt}`, source]),
    ).values()],
    confidenceScore: Math.max(primary.confidenceScore, secondary.confidenceScore),
  }
}

export async function deduplicateRawThreats(
  threats: RawThreat[],
  options: {
    confidenceThreshold?: number
    similarityThreshold?: number
    embed?: EmbedFn | undefined
    embedBatch?: BatchEmbedFn | undefined
  } = {},
): Promise<DedupResult> {
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD
  const similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD

  const afterConfidence = threats.filter((t) => t.confidenceScore >= confidenceThreshold)
  const confidenceFiltered = threats.length - afterConfidence.length

  let embeddingDuplicates = 0
  let afterEmbedding = afterConfidence
  let embeddingMode: DedupStats['embeddingMode'] = 'none'

  if (afterConfidence.length > 1) {
    if (options.embedBatch || options.embed) {
      try {
        const fingerprints = afterConfidence.map(threatFingerprint)
        const embeddings = await embedFingerprints(fingerprints, options.embedBatch, options.embed)
        const result = dedupeWithEmbeddings(afterConfidence, embeddings, similarityThreshold)
        afterEmbedding = result.kept
        embeddingDuplicates = result.dropped
        embeddingMode = 'embedding'
      } catch (err) {
        agentWarn(`[dedup] embedding dedup failed, falling back to lexical: ${err instanceof Error ? err.message : String(err)}`)
        const result = dedupeByLexical(afterConfidence, similarityThreshold)
        afterEmbedding = result.kept
        embeddingDuplicates = result.dropped
        embeddingMode = 'lexical'
      }
    } else {
      const result = dedupeByLexical(afterConfidence, similarityThreshold)
      afterEmbedding = result.kept
      embeddingDuplicates = result.dropped
      embeddingMode = 'lexical'
    }
  }

  const stats: DedupStats = {
    inputCount: threats.length,
    afterConfidence: afterConfidence.length,
    afterEmbeddingDedup: afterEmbedding.length,
    confidenceFiltered,
    embeddingDuplicates,
    embeddingMode,
    similarityThreshold,
  }

  agentLog(
    `[dedup] input=${stats.inputCount} confidence_kept=${stats.afterConfidence} ` +
      `final=${stats.afterEmbeddingDedup} mode=${stats.embeddingMode} ` +
      `confidence_filtered=${stats.confidenceFiltered} embedding_dupes=${stats.embeddingDuplicates}`,
  )

  return {
    kept: afterEmbedding,
    filteredCount: confidenceFiltered + embeddingDuplicates,
    stats,
  }
}
