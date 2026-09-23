import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectPageIndices } from '@/lib/rag/tree-retriever'
import { readRAGIndexState } from '@/lib/rag/index-state'
import { getRAGIndexJob } from '@/lib/rag/index-job'
import { embedTextsShared } from '@/lib/embeddings/client'

export type RagHealthIssue =
  | 'chroma_unreachable'
  | 'chroma_http_error'
  | 'empty_index'
  | 'index_building'
  | 'index_incomplete'
  | 'embedding_unavailable'
  | 'page_indices_unusable'
  | null

export type RagHealth = {
  status: 'up' | 'down'
  usable: boolean
  endpoint: string
  reason: string
  recovery: string[]
  issue: RagHealthIssue
  documentCount: number | null
  pageIndexNodes: number
  warning?: string
}

export type ChromaProbeConfig = {
  chromaHost: string
  chromaPort: number
  knowledgeBasePath?: string
  pageIndicesPath?: string
  ollamaBaseUrl?: string
  embeddingModel?: string
}

const CHROMA_TENANT = 'default_tenant'
const CHROMA_DATABASE = 'default_database'
// Ollama may need to swap a generation model out before loading the embedding
// model. A five-second probe produced false negatives on otherwise healthy
// local installations.
const EMBEDDING_HEALTH_TIMEOUT_MS = 30_000

function chromaEndpoint(config: ChromaProbeConfig): string {
  return `http://${config.chromaHost}:${config.chromaPort}`
}

function dockerLooksInstalled(): boolean {
  return (
    existsSync('/Applications/Docker.app') ||
    existsSync('/var/run/docker.sock') ||
    existsSync(join(homedir(), '.docker/run/docker.sock'))
  )
}

export function recoveryStepsForChroma(config: ChromaProbeConfig): string[] {
  const endpoint = chromaEndpoint(config)
  const steps = [
    `Confirm Chroma answers ${endpoint}/api/v2/heartbeat. Next.js on port 3000 does not start this service.`,
    'Start it with Docker: pnpm services:up   (or make services-up).',
    'Or run Chroma without Docker: uvx --from chromadb chroma run --path ./chroma-data',
    'Then open Knowledge and index the corpus before expecting retrieval.',
  ]
  if (!dockerLooksInstalled()) {
    steps.splice(
      1,
      0,
      'Docker is not available on this machine, so compose-based Chroma cannot start until Docker Desktop is installed and running.',
    )
  }
  return steps
}

function recoveryStepsForEmptyIndex(): string[] {
  return [
    'Open Knowledge and index the corpus, or run pnpm rag:index after Chroma is up.',
    'Confirm knowledge_base/ has approved documents. The git checkout ships empty corpus folders.',
  ]
}

function pageIndicesDir(config: ChromaProbeConfig): string {
  return resolve(process.cwd(), config.pageIndicesPath ?? 'data/page_indices')
}

type ChromaInventory = {
  documentCount: number | null
  collectionNames: string[]
}

function collectionName(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null
  const name = (item as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0 ? name : null
}

function collectionId(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null
  const id = (item as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function parseCountBody(body: unknown): number | null {
  if (typeof body === 'number' && Number.isInteger(body) && body >= 0) return body
  if (body && typeof body === 'object' && typeof (body as { count?: unknown }).count === 'number') {
    const count = (body as { count: number }).count
    return Number.isInteger(count) && count >= 0 ? count : null
  }
  return null
}

export async function probeChromaInventory(endpoint: string, expected?: Record<string, { name: string; count: number }>): Promise<ChromaInventory> {
  const collectionsUrl = `${endpoint}/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections`
  try {
    let selected: unknown[]
    if (expected) {
      // Lookup published names directly: old generations must not affect pagination or readiness.
      selected = await Promise.all(Object.values(expected).map(async entry => {
        const response = await fetch(`${collectionsUrl}/${encodeURIComponent(entry.name)}`, { signal: AbortSignal.timeout(2000) })
        if (!response.ok) throw new Error(`Published collection unavailable: ${entry.name}`)
        const collection: unknown = await response.json()
        if (collectionName(collection) !== entry.name || !collectionId(collection)) throw new Error('Invalid collection response')
        return collection
      }))
    } else {
      const res = await fetch(collectionsUrl, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return { documentCount: null, collectionNames: [] }
      const body: unknown = await res.json()
      selected = Array.isArray(body) ? body
        : body && typeof body === 'object' && Array.isArray((body as { collections?: unknown }).collections)
          ? (body as { collections: unknown[] }).collections : []
    }
    const collectionNames = selected.map(collectionName).filter((name): name is string => name !== null)
    const ids = selected.map(collectionId).filter((id): id is string => id !== null)
    if (ids.length === 0) {
      return { documentCount: collectionNames.length === 0 ? 0 : null, collectionNames }
    }
    const counts = await Promise.all(
      ids.map(async (id) => {
        try {
          const countRes = await fetch(`${collectionsUrl}/${id}/count`, { signal: AbortSignal.timeout(2000) })
          if (!countRes.ok) return null
          return parseCountBody(await countRes.json())
        } catch {
          return null
        }
      }),
    )
    if (expected && counts.some((count, i) => count !== Object.values(expected).find(entry => entry.name === collectionNames[i])?.count)) {
      return { documentCount: null, collectionNames }
    }
    const known = counts.filter((count): count is number => count !== null)
    return {
      documentCount: known.length === counts.length ? known.reduce((sum, count) => sum + count, 0) : null,
      collectionNames,
    }
  } catch {
    return { documentCount: null, collectionNames: [] }
  }
}

function downHealth(
  config: ChromaProbeConfig,
  issue: Extract<RagHealthIssue, 'chroma_unreachable' | 'chroma_http_error'>,
  reason: string,
  pageIndexNodes: number,
): RagHealth {
  return {
    status: 'down',
    usable: false,
    endpoint: chromaEndpoint(config),
    reason,
    recovery: recoveryStepsForChroma(config),
    issue,
    documentCount: null,
    pageIndexNodes,
  }
}

export async function probeRagHealth(config: ChromaProbeConfig): Promise<RagHealth> {
  const endpoint = chromaEndpoint(config)
  const trees = inspectPageIndices(pageIndicesDir(config))
  const heartbeat = `${endpoint}/api/v2/heartbeat`

  try {
    const res = await fetch(heartbeat, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) {
      return downHealth(
        config,
        'chroma_http_error',
        `Chroma answered ${heartbeat} with HTTP ${res.status}. RAG retrieval is not available.`,
        trees.nodeCount,
      )
    }
  } catch {
    return downHealth(
      config,
      'chroma_unreachable',
      `Chroma is not running at ${endpoint}. Analysts can still run, but they will not retrieve knowledge-base evidence until Chroma is up.`,
      trees.nodeCount,
    )
  }

  const indexJob = getRAGIndexJob()
  const savedIndex = await readRAGIndexState(config.knowledgeBasePath)
  const recoveredSinceFailure = Boolean(savedIndex && indexJob.startedAt
    && Date.parse(savedIndex.indexedAt) >= Date.parse(indexJob.startedAt))
  if (indexJob.status === 'running' || (indexJob.status === 'failed' && !recoveredSinceFailure)) {
    const running = indexJob.status === 'running'
    return {
      status: 'up', usable: false, endpoint,
      issue: running ? 'index_building' : 'index_incomplete',
      reason: running
        ? 'The knowledge index is rebuilding. Wait for indexing to finish before starting a scan with RAG.'
        : 'The last knowledge rebuild failed. Open Knowledge and retry indexing before starting a scan with RAG.',
      recovery: [running ? 'Follow indexing progress in Knowledge.' : 'Open Knowledge, inspect the index error, and retry reindexing.'],
      documentCount: null, pageIndexNodes: trees.nodeCount,
    }
  }

  if (config.knowledgeBasePath && (!savedIndex?.collections || savedIndex.embeddingModel !== config.embeddingModel)) {
    return { status: 'up', usable: false, endpoint, issue: 'index_incomplete',
      reason: 'The corpus needs a verified index generation. Open Knowledge and reindex.',
      recovery: recoveryStepsForEmptyIndex(), documentCount: null, pageIndexNodes: trees.nodeCount }
  }

  const inventory = await probeChromaInventory(endpoint, savedIndex?.collections)
  const collectionsLookEmpty =
    inventory.documentCount === 0
    || inventory.documentCount === null

  if (collectionsLookEmpty) {
    return {
      status: 'up',
      usable: false,
      endpoint,
      issue: 'empty_index',
      reason: `Chroma is reachable at ${endpoint}, but no non-empty vector collection could be verified. Open Knowledge and index the corpus before this scan.`,
      recovery: recoveryStepsForEmptyIndex(),
      documentCount: inventory.documentCount,
      pageIndexNodes: trees.nodeCount,
    }
  }


  if (!config.ollamaBaseUrl || !config.embeddingModel) {
    return {
      status: 'up', usable: false, endpoint, issue: 'embedding_unavailable',
      reason: 'Embedding provider configuration is incomplete.',
      recovery: ['Configure OLLAMA_BASE_URL and EMBEDDING_MODEL, then retry.'],
      documentCount: inventory.documentCount, pageIndexNodes: trees.nodeCount,
    }
  }
  try {
    const [probe] = await embedTextsShared(
      config.ollamaBaseUrl,
      config.embeddingModel,
      ['agentic-tm embedding readiness probe'],
      { timeoutMs: EMBEDDING_HEALTH_TIMEOUT_MS, bypassCircuit: true },
    )
    if (!probe?.length) throw new Error('empty embedding')
  } catch (error) {
    return {
      // This status describes the Chroma endpoint. Retrieval remains blocked
      // through `usable` while the separate embedding dependency is unhealthy.
      status: 'up', usable: false, endpoint, issue: 'embedding_unavailable',
      reason: `The configured embedding model is unavailable (${error instanceof Error ? error.message : String(error)}).`,
      recovery: [`Confirm ${config.embeddingModel} is installed and reachable at ${config.ollamaBaseUrl}.`],
      documentCount: inventory.documentCount, pageIndexNodes: trees.nodeCount,
      ...(trees.error ? { warning: trees.error } : {}),
    }
  }

  const warning = trees.error
    ? `Some page-index files were ignored: ${trees.error}`
    : undefined

  return {
    status: 'up',
    usable: true,
    endpoint,
    issue: null,
    reason: warning ?? `Chroma is reachable at ${endpoint}. Knowledge retrieval can run.`,
    recovery: warning ? recoveryStepsForEmptyIndex() : [],
    documentCount: inventory.documentCount,
    pageIndexNodes: trees.nodeCount,
    ...(warning ? { warning } : {}),
  }
}
