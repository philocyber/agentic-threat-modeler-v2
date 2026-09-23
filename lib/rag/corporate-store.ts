import { createHash } from 'node:crypto'
import { ChromaClient, type Collection } from 'chromadb'
import type { AppConfig } from '@/lib/config'
import { createOllamaBatchEmbedFn } from '@/lib/embeddings/client'
import { formatOllamaRetrievalQuery } from '@/lib/embeddings/ollama-api'
import { chunkGlobalDocument, loadGlobalCorpusDocuments } from './global-corpus'
import type { RAGResult } from './store'
import { registerRAGIndexInvalidator } from './index-generation'
import { RAG_INDEX_FORMAT_VERSION, CORPORATE_CHUNK_SIZE, CORPORATE_CHUNK_OVERLAP } from './constants'
import { metadataContext } from './document'
import { readRAGIndexState } from './index-state'
import { buildIndexGeneration, type PublishedCollection } from './generation'
import { scopeMismatch, type EvidenceScope } from './ranking'

export const CORPORATE_COLLECTION_NAME = 'tm_corporate'

function corpusFingerprint(
  documents: Awaited<ReturnType<typeof loadGlobalCorpusDocuments>>,
  embeddingModel: string,
): string {
  const hash = createHash('sha256').update(`format:${RAG_INDEX_FORMAT_VERSION}:${CORPORATE_CHUNK_SIZE}:${CORPORATE_CHUNK_OVERLAP}\nmodel:${embeddingModel}\n`)
  for (const document of documents) hash.update(`${document.path}:${document.sha256}\n`)
  return hash.digest('hex')
}

/** Shared corporate knowledge for this installation. Reviewer learning remains project-scoped. */
export class CorporateRAGStore {
  private readonly client: ChromaClient
  private readonly embedBatch: ReturnType<typeof createOllamaBatchEmbedFn>
  private collection: Collection | null = null
  private sources: Array<{ path: string; sha256: string; chunks: number }> = []

  constructor(private readonly config: AppConfig) {
    this.client = new ChromaClient({ host: config.rag.chromaHost, port: config.rag.chromaPort })
    this.embedBatch = createOllamaBatchEmbedFn(config)
  }

  async init(options: { rebuild?: boolean } = {}): Promise<void> {
    try {
      if (!options.rebuild) {
        const receipt = await readRAGIndexState(this.config.rag.knowledgeBasePath)
        const active = receipt?.collections?.tm_corporate
        if (active) {
          if (receipt?.embeddingModel !== this.config.rag.embeddingModel) throw new Error('Corporate index model changed; reindex required')
          this.collection = await this.client.getCollection({ name: active.name })
          return
        }
        throw new Error('No published corporate generation; reindex required')
      }
      await this.syncCorpus()
    } catch (error) {
      console.warn('[rag] corporate vector index unavailable:', error instanceof Error ? error.message : error)
      this.collection = null
    }
  }

  sourceInventory() { return this.sources.map(source => ({ ...source })) }

  async publishedCollection(): Promise<PublishedCollection> {
    if (!this.collection) throw new Error('Corporate generation unavailable')
    return { name: this.collection.name, count: await this.collection.count() }
  }

  private async syncCorpus(): Promise<void> {
    const documents = await loadGlobalCorpusDocuments('corporate', this.config.rag.knowledgeBasePath)
    this.sources = documents.map(document => ({ path: `corporate/${document.path}`, sha256: document.sha256, chunks: chunkGlobalDocument(document).length }))
    const fingerprint = corpusFingerprint(documents, this.config.rag.embeddingModel)
    const generation = `${CORPORATE_COLLECTION_NAME}_${fingerprint.slice(0, 24)}`
    const chunks = documents.flatMap(document => chunkGlobalDocument(document))
    const entries = chunks.map(chunk => ({
      id: createHash('sha256').update(`${chunk.path}:${chunk.sha256}:${chunk.start}:${chunk.end}`).digest('hex'),
      document: chunk.text,
      input: `${metadataContext(chunk.metadata)}\n${chunk.sectionPath}\n${chunk.qualification}\n${chunk.structureContext ?? ""}\n${chunk.text}`,
      metadata: { ...chunk.metadata, domain: 'corporate', scope: 'tool', source: chunk.path,
        sourceType: chunk.sourceType, sha256: chunk.sha256, chunkIndex: chunk.chunkIndex,
        sectionPath: chunk.sectionPath, start: chunk.start, end: chunk.end, qualification: chunk.qualification, structureContext: chunk.structureContext ?? '' },
    }))
    await buildIndexGeneration({ client: this.client, name: generation, model: this.config.rag.embeddingModel, entries, embed: this.embedBatch })
    const next = await this.client.getCollection({ name: generation })
    this.collection = next
  }

  async query(queryText: string, topK = 5, scope: EvidenceScope = {}): Promise<RAGResult[]> {
    if (!this.collection || !queryText.trim()) return []
    try {
      const query = formatOllamaRetrievalQuery(this.config.rag.embeddingModel, queryText)
      const [embedding] = await this.embedBatch([query])
      if (!embedding) return []
      const result = await this.collection.query({
        queryEmbeddings: [embedding],
        nResults: Math.max(1, Math.min(topK, 30)),
      })
      return (result.documents[0] ?? []).map((document, index) => ({
        id: result.ids[0]?.[index] ?? '',
        document: document ?? '',
        metadata: (result.metadatas[0]?.[index] as Record<string, unknown>) ?? {},
        distance: result.distances[0]?.[index] ?? 1,
        source: 'corporate',
      })).filter(item => !scopeMismatch(item.metadata, scope))
    } catch (error) {
      console.warn('[rag] corporate query failed:', error instanceof Error ? error.message : error)
      return []
    }
  }

  isAvailable(): boolean {
    return this.collection !== null
  }
}

let corporateStore: Promise<CorporateRAGStore> | null = null
let corporateScope = ''

export async function getCorporateRAGStore(config: AppConfig): Promise<CorporateRAGStore> {
  const receipt = await readRAGIndexState(config.rag.knowledgeBasePath)
  const scope = JSON.stringify([config.rag.chromaHost, config.rag.chromaPort, config.rag.knowledgeBasePath, config.rag.embeddingModel, receipt?.fingerprint])
  if (!corporateStore || scope !== corporateScope) {
    corporateScope = scope
    corporateStore = (async () => {
      const store = new CorporateRAGStore(config)
      await store.init()
      return store
    })()
  }
  const pending = corporateStore
  const store = await pending
  if (!store.isAvailable() && corporateStore === pending) corporateStore = null
  return store
}

function clearCorporateRAGStores(): void {
  corporateStore = null
  corporateScope = ''
}

registerRAGIndexInvalidator('corporate-store', clearCorporateRAGStores)
