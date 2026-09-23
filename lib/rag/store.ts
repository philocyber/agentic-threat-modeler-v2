import { ChromaClient, Collection, type Where } from 'chromadb'
import path from 'path'
import { clearPageIndexCache, loadPageIndices, keywordTreeSearch } from './tree-retriever'
import type { TreeRetrievalResult } from './tree-retriever'
import type { AppConfig } from '@/lib/config'
import { formatOllamaRetrievalQuery } from '@/lib/embeddings/ollama-api'
import { embedTextsShared } from '@/lib/embeddings/client'
import { registerRAGIndexInvalidator } from './index-generation'
import { readRAGIndexState } from './index-state'

// ─── Collection names ─────────────────────────────────────────────────────────

export const TECHNICAL_COLLECTIONS = {
  technical: 'tm_technical',
  books: 'tm_books',
  research: 'tm_research',
  risks: 'tm_risks_mitigations',
  aiThreats: 'tm_ai_threats',
} as const
const TECHNICAL_CATALOG_COLLECTION = 'tm_technical_catalog'

export type TechnicalCollectionName = keyof typeof TECHNICAL_COLLECTIONS

// ─── Query result ─────────────────────────────────────────────────────────────

export type RAGResult = {
  id: string
  document: string
  metadata: Record<string, unknown>
  distance: number
  source: string
}

// ─── Embedding via Ollama ─────────────────────────────────────────────────────

async function embedText(text: string, ollamaBaseUrl: string, model: string): Promise<number[]> {
  const query = formatOllamaRetrievalQuery(model, text)
  const [embedding] = await embedTextsShared(ollamaBaseUrl, model, [query])
  if (!embedding) throw new Error('Ollama embed returned no embeddings')
  return embedding
}

// ─── Cache (TTL 30 min per run) ───────────────────────────────────────────────

type CacheEntry = { results: RAGResult[]; expiresAt: number }
const _queryCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX_ENTRIES = 1_000

function cacheGet(key: string): RAGResult[] | null {
  const entry = _queryCache.get(key)
  if (!entry || Date.now() > entry.expiresAt) return null
  return entry.results
}

function cacheSet(key: string, results: RAGResult[]): void {
  const now = Date.now()
  for (const [candidate, entry] of _queryCache) {
    if (entry.expiresAt <= now) _queryCache.delete(candidate)
  }
  if (_queryCache.has(key)) _queryCache.delete(key)
  _queryCache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS })
  while (_queryCache.size > CACHE_MAX_ENTRIES) {
    const oldest = _queryCache.keys().next().value as string | undefined
    if (!oldest) break
    _queryCache.delete(oldest)
  }
}

// ─── RAGStoreManager ─────────────────────────────────────────────────────────

export class RAGStoreManager {
  private client: ChromaClient
  private collections: Partial<Record<TechnicalCollectionName, Collection>> = {}
  private catalog: Collection | null = null
  private ollamaBaseUrl: string
  private embeddingModel: string
  private configuredTopK: number
  private cacheScope: string
  private knowledgeBasePath: string
  private pageIndicesPath: string
  private pageIndices: ReturnType<typeof loadPageIndices>

  constructor(config: AppConfig) {
    this.cacheScope = JSON.stringify([config.rag.chromaHost, config.rag.chromaPort, config.rag.embeddingModel, config.rag.knowledgeBasePath])
    this.client = new ChromaClient({
      host: config.rag.chromaHost,
      port: config.rag.chromaPort,
    })
    this.ollamaBaseUrl = config.llm.ollamaBaseUrl
    this.embeddingModel = config.rag.embeddingModel
    this.configuredTopK = config.rag.topK
    this.knowledgeBasePath = config.rag.knowledgeBasePath
    this.pageIndicesPath = path.resolve(config.rag.pageIndicesPath)
    this.pageIndices = loadPageIndices(this.pageIndicesPath)
  }

  async init(): Promise<void> {
    const receipt = await readRAGIndexState(this.knowledgeBasePath)
    if (receipt?.collections) {
      if (receipt.embeddingModel !== this.embeddingModel) throw new Error('RAG embedding model changed; reindex required')
      this.cacheScope += `:${receipt.fingerprint}`
      const resolveCollection = async (logical: string) => {
        const active = receipt.collections![logical]
        if (!active) throw new Error(`Published index is missing ${logical}`)
        return this.client.getCollection({ name: active.name })
      }
      this.catalog = await resolveCollection(TECHNICAL_CATALOG_COLLECTION)
      for (const [key, name] of Object.entries(TECHNICAL_COLLECTIONS) as [TechnicalCollectionName, string][]) {
        this.collections[key] = await resolveCollection(name)
      }
      return
    }
    throw new Error('No verified RAG generation is published; reindex required')
  }

  private async queryCollection(
    collection: Collection | undefined | null,
    source: string,
    queryText: string,
    topK: number,
    where?: Where,
  ): Promise<{ results: RAGResult[]; cacheHit: boolean }> {
    const cacheKey = `${this.cacheScope}:${source}:${queryText}:${topK}:${JSON.stringify(where ?? {})}`
    const cached = cacheGet(cacheKey)
    if (cached) return { results: cached, cacheHit: true }
    if (!collection) return { results: [], cacheHit: false }

    try {
      const queryEmbedding = await embedText(queryText, this.ollamaBaseUrl, this.embeddingModel)

      const results = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: topK,
        ...(where ? { where } : {}),
      })

      const mapped: RAGResult[] = (results.documents[0] ?? []).map((doc, i) => ({
        id: results.ids[0]?.[i] ?? '',
        document: doc ?? '',
        metadata: (results.metadatas?.[0]?.[i] as Record<string, unknown>) ?? {},
        distance: results.distances?.[0]?.[i] ?? 1,
        source,
      }))

      cacheSet(cacheKey, mapped)
      return { results: mapped, cacheHit: false }
    } catch (err) {
      console.warn(
        `[rag] query failed for ${source}:`,
        err instanceof Error ? err.message : err
      )
      return { results: [], cacheHit: false }
    }
  }

  async query(collectionName: TechnicalCollectionName, queryText: string, topK = 5): Promise<RAGResult[]> {
    return (await this.queryCollection(this.collections[collectionName], collectionName, queryText, topK)).results
  }

  async hierarchicalQuery(
    collectionName: TechnicalCollectionName,
    queryText: string,
    topK = 5,
  ): Promise<{ results: RAGResult[]; catalog: RAGResult[]; cacheHits: number }> {
    if (!this.catalog) {
      const direct = await this.queryCollection(this.collections[collectionName], collectionName, queryText, topK)
      return { results: direct.results, catalog: [], cacheHits: Number(direct.cacheHit) }
    }
    const catalogQuery = await this.queryCollection(this.catalog, 'catalog', queryText, Math.max(4, Math.ceil(topK * 1.5)), {
      collectionKey: { $eq: collectionName },
    })
    const sources = [...new Set(catalogQuery.results.map((result) => String(result.metadata.source ?? '')).filter(Boolean))]
    if (sources.length === 0) {
      const direct = await this.queryCollection(this.collections[collectionName], collectionName, queryText, topK)
      return { results: direct.results, catalog: [], cacheHits: Number(catalogQuery.cacheHit) + Number(direct.cacheHit) }
    }
    const childQuery = await this.queryCollection(
      this.collections[collectionName],
      collectionName,
      queryText,
      Math.max(topK * 2, topK),
      { source: { $in: sources } },
    )
    const perSource = new Map<string, number>()
    const results = childQuery.results.filter((result) => {
      const sourceName = String(result.metadata.source ?? result.source)
      const count = perSource.get(sourceName) ?? 0
      if (count >= 2) return false
      perSource.set(sourceName, count + 1)
      return true
    }).slice(0, topK)
    return {
      results,
      catalog: catalogQuery.results,
      cacheHits: Number(catalogQuery.cacheHit) + Number(childQuery.cacheHit),
    }
  }

  async countDocuments(collectionName: TechnicalCollectionName): Promise<number> {
    const collection = this.collections[collectionName]
    if (!collection) return 0
    try {
      return await collection.count()
    } catch {
      return 0
    }
  }

  async hasAnyIndexedContent(): Promise<boolean> {
    const names = Object.keys(TECHNICAL_COLLECTIONS) as TechnicalCollectionName[]
    for (const name of names) {
      if ((await this.countDocuments(name)) > 0) return true
    }
    return false
  }

  async hybridQuery(
    collectionName: TechnicalCollectionName,
    queryText: string,
    topK = 5
  ): Promise<{ vector: RAGResult[]; tree: TreeRetrievalResult[] }> {
    this.pageIndices = loadPageIndices(this.pageIndicesPath)
    const [vector, tree] = await Promise.all([
      this.query(collectionName, queryText, topK),
      Promise.resolve(keywordTreeSearch(this.pageIndices, queryText, Math.ceil(topK / 2))),
    ])
    return { vector, tree }
  }

  /** Section-aware lexical retrieval over the pre-built document trees. */
  async treeQuery(queryText: string, topK = 3): Promise<TreeRetrievalResult[]> {
    this.pageIndices = loadPageIndices(this.pageIndicesPath)
    return keywordTreeSearch(this.pageIndices, queryText, topK)
  }

  async multiQuery(
    collectionNames: TechnicalCollectionName[],
    queryText: string,
    topKPerCollection = 3
  ): Promise<RAGResult[]> {
    const results = await Promise.all(
      collectionNames.map((c) => this.query(c, queryText, topKPerCollection))
    )
    return results.flat()
  }

  isAvailable(collectionName: TechnicalCollectionName): boolean {
    return collectionName in this.collections
  }

  getConfiguredTopK(): number {
    return this.configuredTopK
  }

  clearCache(): void {
    _queryCache.clear()
  }

  refreshPageIndices(): void {
    this.pageIndices = loadPageIndices(this.pageIndicesPath)
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: Promise<RAGStoreManager> | null = null
let _instanceScope = ''

export async function getRAGStore(config: AppConfig): Promise<RAGStoreManager> {
  clearPageIndexCache()
  const receipt = await readRAGIndexState(config.rag.knowledgeBasePath)
  const scope = JSON.stringify([config.rag.chromaHost, config.rag.chromaPort, config.rag.knowledgeBasePath, config.rag.embeddingModel, receipt?.fingerprint])
  if (!_instance || scope !== _instanceScope) {
    _instanceScope = scope
    const pending = (async () => {
      const store = new RAGStoreManager(config)
      await store.init()
      return store
    })()
    _instance = pending
    try { await pending } catch (error) {
      if (_instance === pending) _instance = null
      throw error
    }
    return pending
  }
  const store = await _instance
  store.refreshPageIndices()
  return store
}

function clearRAGStore(): void {
  _queryCache.clear()
  clearPageIndexCache()
  _instance = null
  _instanceScope = ''
}

registerRAGIndexInvalidator('technical-store', clearRAGStore)
