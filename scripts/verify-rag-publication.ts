/** Read-only local acceptance: published vectors, book coverage and bibliography. */
import { config as loadEnv } from 'dotenv'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ChromaClient } from 'chromadb'
import { getConfig } from '@/lib/config'
import { getRAGIndexReadiness } from '@/lib/rag/index-state'
import { probeChromaInventory } from '@/lib/health/rag-status'
import { embedWithOllama } from '@/lib/embeddings/ollama-api'
import { RAGStoreManager } from '@/lib/rag/store'
import { parseDocument } from '@/lib/rag/document'
import { makePassage } from '@/lib/rag/evidence'

loadEnv({ path: '.env.local', quiet: true })
loadEnv({ path: '.env', quiet: true })
const output = path.resolve('output/qa/rag-publication.json')
const report: Record<string, unknown> = { status: 'running', startedAt: new Date().toISOString(), liveCloud: false }
async function save() {
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function main() {
  const config = getConfig()
  const endpoint = `http://${config.rag.chromaHost}:${config.rag.chromaPort}`
  requireCheck(config.rag.embeddingModel === 'qwen3-embedding:4b', 'Embedding model unexpectedly changed')
  if (process.argv.includes('--wait')) {
    const deadline = Date.now() + 60 * 60_000
    report.status = 'waiting-for-index'
    await save()
    while (true) {
      const response = await fetch('http://127.0.0.1:3000/api/v1/index', { signal: AbortSignal.timeout(15_000) })
      requireCheck(response.ok, 'Cannot read local index status')
      const overview = await response.json()
      if (overview.job.status === 'failed') throw new Error(`Reindex failed: ${overview.job.error}`)
      if (!overview.index.needsReindex && overview.index.reason === 'up-to-date') break
      requireCheck(Date.now() < deadline, 'Timed out waiting for the index publication')
      await new Promise(resolve => setTimeout(resolve, 15_000))
    }
  }
  const { readiness, state } = await getRAGIndexReadiness(config.rag.embeddingModel, config.rag.knowledgeBasePath)
  requireCheck(!readiness.needsReindex && state?.collections && state.sources, 'Corpus has no current verified publication')
  const inventory = await probeChromaInventory(endpoint, state.collections)
  requireCheck(inventory.documentCount && inventory.documentCount > 0, 'Published collection counts failed verification')
  report.status = 'checking'
  report.index = { fingerprint: state.fingerprint, sources: state.sourceCount, collections: state.collections, totalRecords: inventory.documentCount }
  await save()
  // Inputs intentionally exceed the removed 2,000-character cutoff. The long
  // prefix is identical; meaningful, different suffixes must change the vector.
  const prefix = 'Document context and introductory material. '.repeat(55)
  const input = [prefix + 'Identity controls: authentication, permissions and least privilege.', prefix + 'Backup controls: retention, restoration and disaster recovery.']
  const vectors = await embedWithOllama(config.llm.ollamaBaseUrl, config.rag.embeddingModel, input)
  const difference = Math.sqrt(vectors[0]!.reduce((sum, x, i) => sum + (x - vectors[1]![i]!) ** 2, 0))
  requireCheck(difference > 0.00001, 'Different text after character 2000 produced indistinguishable vectors')
  report.embeddings = { model: config.rag.embeddingModel, dimensions: vectors[0]!.length, inputCharacters: input.map(text => text.length), suffixVectorDistance: difference }
  const client = new ChromaClient({ host: config.rag.chromaHost, port: config.rag.chromaPort })
  const books = await client.getCollection({ name: state.collections.tm_books!.name })
  const bookSources = state.sources.filter(source => /(^|\/)books\//.test(source.path))
  requireCheck(bookSources.length > 0, 'No published books to validate')
  const coverage = []
  for (const source of bookSources) {
    requireCheck(path.extname(source.path).toLowerCase() === '.md', `Book verification requires reviewed Markdown: ${source.path}`)
    const body = parseDocument(await readFile(path.resolve(config.rag.knowledgeBasePath, source.path), 'utf8')).body
    // Bounded retrieval of each book, with source-order reconstruction below.
    const chunks: Array<{ start: number; end: number; document: string }> = []
    for (let offset = 0; offset < source.chunks; offset += 100) {
      const batch = await books.get({ where: { source: { $eq: source.path } }, offset, limit: 100, include: ['documents', 'metadatas'] })
      for (let i = 0; i < batch.ids.length; i++) {
        const metadata = batch.metadatas[i]!
        requireCheck(metadata.sha256 === source.sha256, `Version mismatch: ${source.path}`)
        chunks.push({ start: Number(metadata.start), end: Number(metadata.end), document: batch.documents[i] ?? '' })
      }
    }
    requireCheck(chunks.length === source.chunks, `Missing book chunks: ${source.path}`)
    let end = 0
    for (const chunk of chunks.sort((a, b) => a.start - b.start)) {
      requireCheck(Number.isInteger(chunk.start) && Number.isInteger(chunk.end) && chunk.start >= 0 && chunk.end > chunk.start && chunk.end <= body.length, `Invalid book span: ${source.path}`)
      requireCheck(chunk.document === body.slice(chunk.start, chunk.end).trim(), `Inexact book text: ${source.path}`)
      requireCheck(chunk.start <= end || !body.slice(end, chunk.start).trim(), `Gap in book coverage: ${source.path}`)
      end = Math.max(end, chunk.end)
    }
    requireCheck(!body.slice(end).trim(), `Book ending omitted: ${source.path}`)
    coverage.push({ source: source.path, chunks: chunks.length, bodyCharacters: body.length, coverage: 'complete-normalized-body' })
  }
  report.books = coverage
  await save()
  const store = new RAGStoreManager(config)
  await store.init()
  const queries = [
    'How do data flow diagrams and trust boundaries support threat modeling?',
    'How should teams prioritize risks and document mitigations during design reviews?',
    'How should threat models be maintained as a system architecture changes?',
  ]
  const retrieval = []
  for (const query of queries) {
    const result = await store.hierarchicalQuery('books', query, 4)
    requireCheck(result.results.length > 0, `No bibliography retrieved: ${query}`)
    const passages = result.results.map(item => makePassage({ ...item, domain: 'technical', source: String(item.metadata.source) }, 'bibliography-acceptance'))
    for (const passage of passages) {
      const source = bookSources.find(item => item.path === passage.source)
      requireCheck(source && source.sha256 === passage.version, 'Bibliography references an unpublished source or version')
      const body = parseDocument(await readFile(path.resolve(config.rag.knowledgeBasePath, passage.source), 'utf8')).body
      requireCheck(body.slice(Number(passage.metadata.start), Number(passage.metadata.end)).trim() === passage.excerpt, 'Bibliography quotation differs from the source')
    }
    retrieval.push({ query, passages: passages.map(p => ({ citationId: p.citationId, source: p.source, section: p.metadata.sectionPath, excerpt: p.excerpt })) })
  }
  report.retrieval = retrieval
  const final = await getRAGIndexReadiness(config.rag.embeddingModel, config.rag.knowledgeBasePath)
  requireCheck(!final.readiness.needsReindex && final.state?.fingerprint === state.fingerprint, 'Corpus changed during validation')
  report.status = 'passed'
  report.limits = 'Storage coverage and citation integrity verified. Retrieval relevance requires reviewing the returned passages. This is not a full LLM scan.'
  report.completedAt = new Date().toISOString()
  await save()
  console.log(`RAG publication acceptance passed: ${output}`)
}
main().catch(async error => {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  await save()
  console.error(report.error)
  process.exitCode = 1
})
