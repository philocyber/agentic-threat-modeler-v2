#!/usr/bin/env tsx
/** Read-only smoke check against the already-built local Chroma/Ollama index. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { config as loadEnv } from 'dotenv'
import { ChromaClient } from 'chromadb'
import { getConfig } from '@/lib/config'
import { embedWithOllama } from '@/lib/embeddings/ollama-api'
import { makePassage, validateEvidenceSources } from '@/lib/rag/evidence'
import { searchGlobalCorpus } from '@/lib/rag/global-corpus'
import { getRAGIndexReadiness } from '@/lib/rag/index-state'

async function main() {
  loadEnv({ path: '.env', quiet: true })
  loadEnv({ path: '.env.local', override: true, quiet: true })
  const config = getConfig()
  const client = new ChromaClient({ host: config.rag.chromaHost, port: config.rag.chromaPort })
  await client.heartbeat()
  const pointer = await client.getCollection({ name: 'tm_corporate' })
  const active = pointer.metadata?.activeCollection
  assert.equal(typeof active, 'string', 'Corporate generation must be published')
  const corporate = await client.getCollection({ name: String(active) })
  const [queryEmbedding] = await embedWithOllama(config.llm.ollamaBaseUrl, config.rag.embeddingModel, ['Seguridad threat model análisis derivado controles internos'])
  assert.ok(queryEmbedding?.length, 'Embedding service must return a vector')
  const result = await corporate.query({ queryEmbeddings: [queryEmbedding], nResults: 5 })
  assert.ok(result.ids[0]?.length, 'Published corporate generation must return passages')
  for (let i = 0; i < result.ids[0]!.length; i++) {
    const metadata = result.metadatas[0]?.[i] ?? {}
    assert.ok(metadata.sha256 && metadata.sectionPath, 'Indexed chunks need source versions and sections')
    const passage = makePassage({ id: result.ids[0]![i]!, domain: 'corporate', source: String(metadata.source), document: result.documents[0]?.[i] ?? '', metadata }, 'smoke')
    const source = { sourceType: 'rag' as const, sourceName: passage.citationId, excerpt: passage.excerpt }
    assert.equal(validateEvidenceSources([source], [passage]).sources.length, 1)
    assert.equal(validateEvidenceSources([source], []).rejected, 1)
  }
  const lexical = await searchGlobalCorpus('corporate', 'threat model INFERRED controles internos', 10, config.rag.knowledgeBasePath)
  assert.ok(lexical.length, 'Section search must return matching source text')
  assert.ok(lexical.some(hit => typeof hit.metadata.qualification === 'string' && /INFERRED/i.test(hit.metadata.qualification)), 'Corporate inferred-analysis qualification must survive retrieval')
  const technical = await client.getCollection({ name: 'tm_ai_threats' })
  const sample = await technical.get({ limit: 5 })
  assert.ok(sample.metadatas.every(metadata => metadata?.sha256 && metadata.sectionPath), 'Technical generation must retain version and section metadata')
  const { readiness } = await getRAGIndexReadiness(config.rag.embeddingModel, config.rag.knowledgeBasePath)
  assert.equal(readiness.needsReindex, false, 'The final corpus fingerprint must be up to date')
  const report = {
    checkedAt: new Date().toISOString(),
    corporateGeneration: active,
    corporateChunks: await corporate.count(),
    technicalSampleChunks: sample.ids.length,
    vectorPassagesVerified: result.ids[0]!.length,
    lexicalQualificationPreserved: true,
    absentRegistryReferencesRejected: true,
    readiness,
    scope: 'Read-only retrieval and evidence-integrity smoke check. No generation-quality or causal RAG gain claim.',
  }
  const destination = process.argv[2]
  if (destination) await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
