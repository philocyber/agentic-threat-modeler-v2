#!/usr/bin/env tsx

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { ChromaClient } from 'chromadb'
import { config as loadEnv } from 'dotenv'
import { PDFParse } from 'pdf-parse'
import { getConfig } from '@/lib/config'
import { resolveKnowledgeRoot, SPECIALIZED_TECHNICAL_DIRECTORIES } from '@/lib/rag/corpus-paths'
import { embedWithOllama, isMissingOllamaModelError, pullOllamaModel } from '@/lib/embeddings/ollama-api'
import { buildIndexGeneration, generationName, type PreparedIndexEntry, type PublishedCollection } from '@/lib/rag/generation'
import { CorporateRAGStore } from '@/lib/rag/corporate-store'
import { documentSections, documentVersion, metadataContext, parseDocument } from '@/lib/rag/document'
import { calculateRAGCorpusSnapshot, writeRAGIndexState } from '@/lib/rag/index-state'
import {
  RAG_INDEX_FORMAT_VERSION,
  TECHNICAL_CHUNK_OVERLAP,
  TECHNICAL_CHUNK_SIZE,
  TECHNICAL_EXTENSIONS,
} from '@/lib/rag/constants'

loadEnv({ path: '.env.local', quiet: true })
loadEnv({ path: '.env', quiet: true })

const CHROMA_HOST = process.env.CHROMA_HOST ?? 'localhost'
const CHROMA_PORT = Number.parseInt(process.env.CHROMA_PORT ?? '8000', 10)
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'qwen3-embedding:4b'
const KB_PATH = resolveKnowledgeRoot()
const ALLOWED_EXTENSIONS = new Set<string>(TECHNICAL_EXTENSIONS)

type SourceFile = { sourcePath: string; content: string; filename: string; extension: string }
type SourceChunk = ReturnType<typeof documentSections>[number]
type CatalogFile = SourceFile & { collectionKey: string }

const client = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT })
let embeddingModelInstallAttempted = false

async function embed(texts: string[]): Promise<number[][]> {
  try {
    return await embedWithOllama(OLLAMA_BASE_URL, EMBEDDING_MODEL, texts)
  } catch (error) {
    if (!embeddingModelInstallAttempted && isMissingOllamaModelError(error)) {
      embeddingModelInstallAttempted = true
      console.log(`Embedding model "${EMBEDDING_MODEL}" is missing. Installing it through Ollama...`)
      console.log('The first install can take a while on slower connections; this reindex job will resume automatically.')
      let lastStatus = ''
      let lastPercent = -10
      await pullOllamaModel(OLLAMA_BASE_URL, EMBEDDING_MODEL, ({ completed, status, total }) => {
        const percent = completed !== null && total ? Math.floor((completed / total) * 10) * 10 : null
        if (percent !== null && percent < 100 && percent >= lastPercent + 10) {
          lastPercent = percent
          console.log(`  ${status}: ${percent}%`)
        } else if (status !== lastStatus && percent === null) {
          console.log(`  ${status}`)
        }
        lastStatus = status
      })
      console.log(`Embedding model "${EMBEDDING_MODEL}" installed. Resuming the index.\n`)
      return embedWithOllama(OLLAMA_BASE_URL, EMBEDDING_MODEL, texts)
    }
    throw error
  }
}

function chunkText(
  text: string,
  chunkSize = TECHNICAL_CHUNK_SIZE,
  overlap = TECHNICAL_CHUNK_OVERLAP,
): SourceChunk[] {
  return documentSections(text, chunkSize, overlap)
}

function catalogDocument(file: SourceFile, collectionKey: string): string {
  const headings = [...file.content.matchAll(/^#{1,6}\s+(.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .slice(0, 24)
  return [
    `Source: ${file.filename}`,
    `Knowledge domain: ${collectionKey}`,
    headings.length ? `Sections: ${headings.join(' | ')}` : '',
    `Synopsis: ${file.content.replace(/\s+/g, ' ').slice(0, 1_500)}`,
  ].filter(Boolean).join('\n')
}

async function extractPdf(filePath: string): Promise<string> {
  const parser = new PDFParse({ data: await readFile(filePath) })
  try {
    return (await parser.getText()).text
  } finally {
    await parser.destroy()
  }
}

async function readSource(filePath: string, filename: string): Promise<SourceFile | null> {
  const extension = path.extname(filePath).toLowerCase()
  try {
    if ((await stat(filePath)).size > 25 * 1024 * 1024) throw new Error('File exceeds the 25 MiB indexing limit')
    let content: string
    if (extension === '.pdf') {
      process.stdout.write(`  extracting ${filename}...`)
      content = await extractPdf(filePath)
      console.log(` ${content.length.toLocaleString()} chars`)
    } else {
      content = await readFile(filePath, 'utf8')
      if (extension === '.json') {
        try {
          content = JSON.stringify(JSON.parse(content), null, 2)
        } catch {
          // Keep malformed JSON as plain text so one source cannot stop the corpus.
        }
      }
    }
    if (!parseDocument(content).body.trim()) throw new Error('Document has no indexable body text')
    return { content, filename, extension, sourcePath: path.relative(KB_PATH, filePath).split(path.sep).join('/') }
  } catch (error) {
    throw new Error(`Cannot index ${filename}: ${error instanceof Error ? error.message : error}`)
  }
}

async function loadCorpusFiles(directory: string, prefix = ''): Promise<SourceFile[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (!prefix && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: SourceFile[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await loadCorpusFiles(fullPath, relativeName))
      continue
    }
    if (!entry.isFile() || !ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    const source = await readSource(fullPath, relativeName)
    if (source) files.push(source)
  }
  return files
}

async function indexCollection(collectionName: string, files: SourceFile[], fingerprint: string): Promise<PublishedCollection> {
  const entries: PreparedIndexEntry[] = []
  for (const file of files) {
    const chunks = chunkText(file.content)
    if (!chunks.length) throw new Error(`No chunks produced for ${file.filename}`)
    const sha256 = documentVersion(file.content)
    const sourceId = createHash('sha256').update(file.sourcePath).digest('hex')
    console.log(`  ${file.filename}: ${chunks.length} chunks`)
    for (const chunk of chunks) entries.push({
      id: createHash('sha256').update(`${file.sourcePath}:${chunk.start}:${chunk.end}`).digest('hex'),
      document: chunk.text,
      input: `${metadataContext(chunk.metadata)}\n${chunk.sectionPath}\n${chunk.qualification}\n${chunk.structureContext ?? ""}\n${chunk.text}`,
      metadata: { ...chunk.metadata, source: file.sourcePath, sha256, sourceId,
        sectionPath: chunk.sectionPath, qualification: chunk.qualification, structureContext: chunk.structureContext ?? "",
        start: chunk.start, end: chunk.end, extension: file.extension,
        collection: collectionName, scope: 'tool', embeddingFormatVersion: RAG_INDEX_FORMAT_VERSION },
    })
  }
  return buildIndexGeneration({ client, name: generationName(collectionName, fingerprint), model: EMBEDDING_MODEL, entries, embed })
}

async function indexCatalog(files: CatalogFile[], fingerprint: string): Promise<PublishedCollection> {
  const entries = files.map(file => {
    const document = catalogDocument(file, file.collectionKey)
    return { id: createHash('sha256').update(`${file.collectionKey}:${file.filename}`).digest('hex'), document, input: document,
      metadata: { source: file.sourcePath, sourceId: createHash('sha256').update(file.sourcePath).digest('hex'),
        extension: file.extension, collectionKey: file.collectionKey, scope: 'tool' } }
  })
  return buildIndexGeneration({ client, name: generationName('tm_technical_catalog', fingerprint), model: EMBEDDING_MODEL, entries, embed })
}

async function main(): Promise<void> {
  console.log('Argus Knowledge Base Indexer')
  console.log(`ChromaDB: ${CHROMA_HOST}:${CHROMA_PORT}`)
  console.log(`Ollama embeddings: ${OLLAMA_BASE_URL} (${EMBEDDING_MODEL})\n`)
  await client.heartbeat()
  const [probe] = await embed(['test'])
  if (!probe) throw new Error('Ollama embedding model returned no vectors')
  console.log(`Services ready. Embedding dimensions: ${probe.length}\n`)
  const startingSnapshot = await calculateRAGCorpusSnapshot(EMBEDDING_MODEL, KB_PATH)

  // Accept both documented top-level folders and folders nested inside
  // knowledge_base/technical. The latter is convenient for keeping all private
  // material under one ignored directory, while logical collections still get
  // their own retrieval quotas and catalog routes.
  const nestedTechnicalFiles = await loadCorpusFiles(path.join(KB_PATH, 'technical'))
  const nested = (prefix: string) => nestedTechnicalFiles.filter((file) => file.filename.startsWith(`${prefix}/`))
  const specializedPrefixes = SPECIALIZED_TECHNICAL_DIRECTORIES.map((directory) => `${directory}/`)
  const technicalFiles = nestedTechnicalFiles.filter((file) => !specializedPrefixes.some((prefix) => file.filename.startsWith(prefix)))
  const researchFiles = [...nested('research'), ...await loadCorpusFiles(path.join(KB_PATH, 'research'))]
  const aiFiles = [...nested('ai_threats'), ...await loadCorpusFiles(path.join(KB_PATH, 'ai_threats'))]
  const bookFiles = [...nested('books'), ...await loadCorpusFiles(path.join(KB_PATH, 'books'))]
  const riskFiles = [...nested('risks_mitigations'), ...await loadCorpusFiles(path.join(KB_PATH, 'risks_mitigations'))]

  const sources = [...technicalFiles, ...researchFiles, ...aiFiles, ...bookFiles, ...riskFiles].map(file => ({
    path: file.sourcePath, sha256: documentVersion(file.content), chunks: chunkText(file.content).length,
  }))
  const collections: Record<string, PublishedCollection> = {}
  // Bound local embedding work to one batch at a time, across all collections.
  for (const [name, files] of [
    ['tm_technical', technicalFiles], ['tm_research', researchFiles], ['tm_ai_threats', aiFiles],
    ['tm_books', bookFiles], ['tm_risks_mitigations', riskFiles],
  ] as Array<[string, SourceFile[]]>) {
    collections[name] = await indexCollection(name, files, startingSnapshot.fingerprint)
  }
  collections.tm_technical_catalog = await indexCatalog([
    ...technicalFiles.map((file) => ({ ...file, collectionKey: 'technical' })),
    ...researchFiles.map((file) => ({ ...file, collectionKey: 'research' })),
    ...aiFiles.map((file) => ({ ...file, collectionKey: 'aiThreats' })),
    ...bookFiles.map((file) => ({ ...file, collectionKey: 'books' })),
    ...riskFiles.map((file) => ({ ...file, collectionKey: 'risks' })),
  ], startingSnapshot.fingerprint)
  const totalFiles = technicalFiles.length + researchFiles.length + aiFiles.length + bookFiles.length + riskFiles.length
  const totalChunks = Object.entries(collections).filter(([name]) => name !== 'tm_technical_catalog').reduce((sum, [, entry]) => sum + entry.count, 0)
  console.log(`Technical indexing complete: ${totalFiles} source files, ${totalChunks} chunks.`)

  console.log('Synchronizing the corporate collection...')
  const corporateStore = new CorporateRAGStore(getConfig())
  await corporateStore.init({ rebuild: true })
  if (!corporateStore.isAvailable()) throw new Error('Corporate Chroma collection is unavailable')
  collections.tm_corporate = await corporateStore.publishedCollection()
  sources.push(...corporateStore.sourceInventory())
  if (sources.length !== startingSnapshot.sourceCount || new Set(sources.map(source => source.path)).size !== sources.length) {
    throw new Error('Source inventory does not match the corpus snapshot')
  }
  console.log('Corporate collection verified.')

  const completedSnapshot = await calculateRAGCorpusSnapshot(EMBEDDING_MODEL, KB_PATH)
  if (completedSnapshot.fingerprint !== startingSnapshot.fingerprint) {
    throw new Error('Knowledge files changed while indexing. Run the index again to capture one consistent corpus version.')
  }
  await writeRAGIndexState(completedSnapshot, { rootPath: KB_PATH, collections, sources })
  console.log('Index state saved. The corpus is up to date.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
