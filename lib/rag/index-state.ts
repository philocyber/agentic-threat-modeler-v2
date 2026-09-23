import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PublishedCollection } from './generation'
import { CORPUS_DIRECTORIES, resolveKnowledgeRoot } from './corpus-paths'
import {
  CORPORATE_EXTENSIONS,
  CORPORATE_CHUNK_OVERLAP,
  CORPORATE_CHUNK_SIZE,
  RAG_INDEX_FORMAT_VERSION,
  TECHNICAL_CHUNK_OVERLAP,
  TECHNICAL_CHUNK_SIZE,
  TECHNICAL_EXTENSIONS,
} from './constants'

const INDEX_STATE_VERSION = RAG_INDEX_FORMAT_VERSION
const INDEX_STATE_FILENAME = '.rag-index-state.json'
const SUPPORTED_EXTENSIONS = {
  technical: new Set<string>(TECHNICAL_EXTENSIONS),
  corporate: new Set<string>(CORPORATE_EXTENSIONS),
}

type CachedDigest = {
  ctimeMs: number
  digest: string
  mtimeMs: number
  size: number
}

const digestCache = new Map<string, CachedDigest>()

export type RAGCorpusSnapshot = {
  embeddingModel: string
  fingerprint: string
  latestModifiedAt: string | null
  sourceCount: number
}

export type RAGIndexState = RAGCorpusSnapshot & {
  indexedAt: string
  collections?: Record<string, PublishedCollection>
  sources?: Array<{ path: string; sha256: string; chunks: number }>
  version: typeof INDEX_STATE_VERSION
}

export type RAGIndexReadiness = {
  indexedAt: string | null
  needsReindex: boolean
  reason: 'embedding-model-changed' | 'knowledge-files-changed' | 'never-indexed' | 'no-source-files' | 'up-to-date' | 'vector-index-empty' | 'vector-index-unavailable' | 'vector-index-incomplete'
  sourceCount: number
}

function knowledgeRoot(rootPath?: string): string {
  return resolveKnowledgeRoot(rootPath)
}

async function collectSourcePaths(rootPath: string): Promise<string[]> {
  const sourcePaths: string[] = []

  async function walk(directory: string, domain: 'technical' | 'corporate'): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && directory === path.join(rootPath, domain)) return
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && CORPUS_DIRECTORIES.some(item => directory === path.join(rootPath, item.directory))) return
      throw error
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(fullPath, domain)
      else if (entry.isFile() && SUPPORTED_EXTENSIONS[domain].has(path.extname(entry.name).toLowerCase())) {
        sourcePaths.push(fullPath)
      }
    }
  }

  await Promise.all(CORPUS_DIRECTORIES.map(({ directory, domain }) => walk(path.join(rootPath, directory), domain)))
  return sourcePaths.sort((left, right) => left.localeCompare(right))
}

async function digestFile(filePath: string): Promise<{ digest: string; mtimeMs: number }> {
  const info = await stat(filePath)
  const cached = digestCache.get(filePath)
  if (cached
    && cached.size === info.size
    && cached.mtimeMs === info.mtimeMs
    && cached.ctimeMs === info.ctimeMs) {
    return cached
  }
  const digest = createHash('sha256').update(await readFile(filePath)).digest('hex')
  digestCache.set(filePath, { ctimeMs: info.ctimeMs, digest, mtimeMs: info.mtimeMs, size: info.size })
  return { digest, mtimeMs: info.mtimeMs }
}

export async function calculateRAGCorpusSnapshot(
  embeddingModel: string,
  rootPath?: string,
): Promise<RAGCorpusSnapshot> {
  const root = knowledgeRoot(rootPath)
  const sourcePaths = await collectSourcePaths(root)
  const fingerprint = createHash('sha256').update(
    `rag-index-v${INDEX_STATE_VERSION}\nmodel:${embeddingModel}\n`
    + `technical:${TECHNICAL_CHUNK_SIZE}:${TECHNICAL_CHUNK_OVERLAP}\n`
    + `corporate:${CORPORATE_CHUNK_SIZE}:${CORPORATE_CHUNK_OVERLAP}\n`,
  )
  let latestModifiedMs = 0

  for (const filePath of sourcePaths) {
    const { digest, mtimeMs } = await digestFile(filePath)
    latestModifiedMs = Math.max(latestModifiedMs, mtimeMs)
    fingerprint.update(`${path.relative(root, filePath).split(path.sep).join('/')}\0${digest}\n`)
  }

  return {
    embeddingModel,
    fingerprint: fingerprint.digest('hex'),
    latestModifiedAt: latestModifiedMs > 0 ? new Date(latestModifiedMs).toISOString() : null,
    sourceCount: sourcePaths.length,
  }
}

function validInventory(state: { sourceCount: number; collections?: RAGIndexState['collections']; sources?: RAGIndexState['sources'] }): boolean {
  const { collections, sources } = state
  const required = ['tm_technical', 'tm_books', 'tm_research', 'tm_ai_threats', 'tm_risks_mitigations', 'tm_technical_catalog', 'tm_corporate']
  if (!collections || typeof collections !== 'object' || Array.isArray(collections)
    || Object.keys(collections).length !== required.length || required.some(name => !collections[name])
    || !Array.isArray(sources) || sources.length !== state.sourceCount) return false
  if (sources.some(source => !source || typeof source.path !== 'string' || !source.path
    || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)
    || !Number.isInteger(source.chunks) || source.chunks <= 0)
    || new Set(sources.map(source => source.path)).size !== sources.length) return false
  if (Object.values(collections).some(collection => !collection || typeof collection.name !== 'string' || !collection.name
    || !Number.isInteger(collection.count) || collection.count < 0)
    || new Set(Object.values(collections).map(collection => collection.name)).size !== required.length) return false
  return sources.reduce((sum, source) => sum + source.chunks, 0) === Object.entries(collections)
    .filter(([name]) => name !== 'tm_technical_catalog').reduce((sum, [, collection]) => sum + collection.count, 0)
}

export async function readRAGIndexState(rootPath?: string): Promise<RAGIndexState | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(knowledgeRoot(rootPath), INDEX_STATE_FILENAME), 'utf8')) as Partial<RAGIndexState>
    if (parsed.version !== INDEX_STATE_VERSION
      || typeof parsed.embeddingModel !== 'string'
      || typeof parsed.fingerprint !== 'string'
      || typeof parsed.indexedAt !== 'string'
      || !Number.isInteger(parsed.sourceCount) || (parsed.sourceCount ?? -1) < 0
      || (parsed.latestModifiedAt !== null && typeof parsed.latestModifiedAt !== 'string')) return null
    if ((parsed.collections !== undefined || parsed.sources !== undefined) && !validInventory(parsed as RAGIndexState)) return null
    return parsed as RAGIndexState
  } catch {
    return null
  }
}

/** Clear the previous success receipt before changing any vector collections. */
export async function invalidateRAGIndexState(rootPath?: string): Promise<void> {
  await rm(path.join(knowledgeRoot(rootPath), INDEX_STATE_FILENAME), { force: true })
}

export async function writeRAGIndexState(
  snapshot: RAGCorpusSnapshot,
  options: { indexedAt?: string; rootPath?: string; collections?: Record<string, PublishedCollection>; sources?: RAGIndexState['sources'] } = {},
): Promise<RAGIndexState> {
  const root = knowledgeRoot(options.rootPath)
  if ((options.collections !== undefined || options.sources !== undefined)
    && !validInventory({ ...snapshot, collections: options.collections, sources: options.sources })) {
    throw new Error('Cannot publish an incomplete corpus inventory')
  }
  const state: RAGIndexState = {
    ...snapshot,
    ...(options.sources ? { sources: options.sources } : {}),
    ...(options.collections ? { collections: options.collections } : {}),
    indexedAt: options.indexedAt ?? new Date().toISOString(),
    version: INDEX_STATE_VERSION,
  }
  await mkdir(root, { recursive: true })
  const statePath = path.join(root, INDEX_STATE_FILENAME)
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' })
  await rename(temporaryPath, statePath)
  return state
}

export function evaluateRAGIndexReadiness(
  snapshot: RAGCorpusSnapshot,
  indexedState: RAGIndexState | null,
): RAGIndexReadiness {
  if (!indexedState) {
    return {
      indexedAt: null,
      needsReindex: snapshot.sourceCount > 0,
      reason: snapshot.sourceCount > 0 ? 'never-indexed' : 'no-source-files',
      sourceCount: snapshot.sourceCount,
    }
  }
  if (indexedState.embeddingModel !== snapshot.embeddingModel) {
    return { indexedAt: indexedState.indexedAt, needsReindex: true, reason: 'embedding-model-changed', sourceCount: snapshot.sourceCount }
  }
  if (indexedState.fingerprint !== snapshot.fingerprint) {
    return { indexedAt: indexedState.indexedAt, needsReindex: true, reason: 'knowledge-files-changed', sourceCount: snapshot.sourceCount }
  }
  return { indexedAt: indexedState.indexedAt, needsReindex: false, reason: 'up-to-date', sourceCount: snapshot.sourceCount }
}

export async function getRAGIndexReadiness(
  embeddingModel: string,
  rootPath?: string,
): Promise<{ readiness: RAGIndexReadiness; snapshot: RAGCorpusSnapshot; state: RAGIndexState | null }> {
  const snapshot = await calculateRAGCorpusSnapshot(embeddingModel, rootPath)
  const state = await readRAGIndexState(rootPath)
  return { readiness: evaluateRAGIndexReadiness(snapshot, state), snapshot, state }
}
