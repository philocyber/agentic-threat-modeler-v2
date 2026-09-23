import { AsyncLocalStorage } from 'node:async_hooks'
import type { AppConfig } from '@/lib/config'
import { embedWithOllama } from './ollama-api'
import { tokenizeSecurityText } from '@/lib/rag/tokenize'

export type EmbedFn = (text: string) => Promise<number[]>
/** Batch variant: one HTTP round-trip per chunk of texts (Ollama /api/embed accepts arrays). */
export type BatchEmbedFn = (texts: string[]) => Promise<number[][]>

type EmbeddingCacheEntry = { value: number[]; expiresAt: number }
const embeddingCache = new Map<string, EmbeddingCacheEntry>()
const embeddingInflight = new Map<string, Promise<number[]>>()
const circuitState = new Map<string, { failures: number; openUntil: number }>()
const degradationHandler = new AsyncLocalStorage<(message: string) => void>()
const EMBEDDING_CACHE_MAX = 2_000
const EMBEDDING_CACHE_TTL_MS = 30 * 60_000
const EMBEDDING_CIRCUIT_COOLDOWN_MS = 60_000

function embeddingKey(baseUrl: string, model: string, text: string): string {
  return `${baseUrl.replace(/\/+$/, '')}\u0000${model}\u0000${text}`
}

function cacheEmbedding(key: string, value: number[]): void {
  const now = Date.now()
  for (const [candidate, entry] of embeddingCache) {
    if (entry.expiresAt <= now) embeddingCache.delete(candidate)
  }
  if (embeddingCache.has(key)) embeddingCache.delete(key)
  embeddingCache.set(key, { value, expiresAt: now + EMBEDDING_CACHE_TTL_MS })
  while (embeddingCache.size > EMBEDDING_CACHE_MAX) {
    const oldest = embeddingCache.keys().next().value as string | undefined
    if (!oldest) break
    embeddingCache.delete(oldest)
  }
}

export async function embedTextsShared(
  baseUrl: string,
  model: string,
  texts: string[],
  options: { timeoutMs?: number; bypassCircuit?: boolean } = {},
): Promise<number[][]> {
  const circuitKey = `${baseUrl.replace(/\/+$/, '')}\u0000${model}`
  const circuit = circuitState.get(circuitKey)
  if (!options.bypassCircuit && circuit && circuit.openUntil > Date.now()) {
    throw new Error(`Embedding circuit open for ${model}`)
  }

  const promises = new Map<string, Promise<number[]>>()
  const missing = [...new Set(texts)].filter((text) => {
    const key = embeddingKey(baseUrl, model, text)
    const cached = embeddingCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      embeddingCache.delete(key)
      embeddingCache.set(key, cached)
      promises.set(text, Promise.resolve(cached.value))
      return false
    }
    const inflight = embeddingInflight.get(key)
    if (inflight) {
      promises.set(text, inflight)
      return false
    }
    return true
  })

  if (missing.length > 0) {
    const batch = embedWithOllama(baseUrl, model, missing, options.timeoutMs).then(
      (embeddings) => {
        circuitState.delete(circuitKey)
        return embeddings
      },
      (error: unknown) => {
        const failures = (circuitState.get(circuitKey)?.failures ?? 0) + 1
        const opensNow = failures >= 2
        circuitState.set(circuitKey, {
          failures,
          openUntil: opensNow ? Date.now() + EMBEDDING_CIRCUIT_COOLDOWN_MS : 0,
        })
        if (opensNow) degradationHandler.getStore()?.(
          `RAG embeddings became unavailable for ${model}; lexical and reviewer evidence were preserved.`,
        )
        throw error
      },
    )
    missing.forEach((text, index) => {
      const key = embeddingKey(baseUrl, model, text)
      const pending = batch.then((embeddings) => {
        const embedding = embeddings[index]
        if (!embedding) throw new Error('Embedding response omitted an item')
        cacheEmbedding(key, embedding)
        return embedding
      }).finally(() => embeddingInflight.delete(key))
      embeddingInflight.set(key, pending)
      promises.set(text, pending)
    })
  }

  return Promise.all(texts.map((text) => promises.get(text)!))
}

export function runWithEmbeddingDegradationHandler<T>(
  handler: (message: string) => void,
  fn: () => Promise<T>,
): Promise<T> {
  return degradationHandler.run(handler, fn)
}


export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Batched Ollama embeddings: `/api/embed` accepts an array of inputs, so N
 * texts cost one HTTP round-trip instead of N. Callers chunk as needed.
 */
export function createOllamaBatchEmbedFn(config: AppConfig): BatchEmbedFn {
  const baseUrl = config.llm.ollamaBaseUrl
  const model = config.rag.embeddingModel

  return async (texts: string[]): Promise<number[][]> => {
    // Model swaps on consumer GPUs can take tens of seconds before the
    // embedding request starts. The shared client keeps a 120-second timeout
    // so dedup does not unnecessarily degrade to lexical comparison.
    return embedTextsShared(baseUrl, model, texts)
  }
}

/** Lexical fallback when embeddings are unavailable. */
export function lexicalSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenizeSecurityText(a))
  const tokensB = new Set(tokenizeSecurityText(b))
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let intersection = 0
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++
  }
  return intersection / Math.max(tokensA.size, tokensB.size)
}

export function _clearEmbeddingClientState(): void {
  embeddingCache.clear()
  embeddingInflight.clear()
  circuitState.clear()
}
