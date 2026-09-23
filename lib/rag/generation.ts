import { createHash } from 'node:crypto'
import type { ChromaClient, Metadata } from 'chromadb'

export type PreparedIndexEntry = { id: string; document: string; input: string; metadata: Metadata }
export type PublishedCollection = { name: string; count: number }

export function generationName(logicalName: string, fingerprint: string): string {
  return `${logicalName}_${fingerprint.slice(0, 24)}`
}

/** Stage and verify a generation. This function never changes the active pointer. */
export async function buildIndexGeneration(params: {
  client: ChromaClient
  name: string
  model: string
  entries: PreparedIndexEntry[]
  embed: (texts: string[]) => Promise<number[][]>
}): Promise<PublishedCollection> {
  const { client, name, model, entries, embed } = params
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error(`Duplicate chunk IDs in ${name}`)
  const collection = await client.getOrCreateCollection({ name, embeddingFunction: null, metadata: { embeddingModel: model } })
  if (collection.metadata?.embeddingModel !== model) throw new Error(`Embedding model mismatch in ${name}`)
  for (let offset = 0; offset < entries.length; offset += 16) {
    const batch = entries.slice(offset, offset + 16).map(entry => ({ ...entry, metadata: {
      ...entry.metadata,
      embeddingInputHash: createHash('sha256').update(entry.input).digest('hex'),
    } }))
    // Fetch only the batch under consideration, not every document in Chroma.
    const stored = await collection.get({ ids: batch.map(entry => entry.id), include: ['documents', 'metadatas'] })
    const existing = new Map(stored.ids.map((id, i) => [id, { document: stored.documents[i], metadata: stored.metadatas[i] }]))
    const changed = batch.filter(entry => {
      const previous = existing.get(entry.id)
      return previous?.document !== entry.document || previous?.metadata?.embeddingInputHash !== entry.metadata.embeddingInputHash
        || JSON.stringify(Object.entries(previous.metadata).sort()) !== JSON.stringify(Object.entries(entry.metadata).sort())
    })
    if (changed.length) {
      const vectors = await embed(changed.map(entry => entry.input))
      if (vectors.length !== changed.length || vectors.some(v => !v.length || v.some(x => !Number.isFinite(x)))) {
        throw new Error(`Invalid embedding batch in ${name}`)
      }
      await collection.upsert({ ids: changed.map(entry => entry.id), documents: changed.map(entry => entry.document),
        metadatas: changed.map(entry => entry.metadata), embeddings: vectors })
    }
    const verified = await collection.get({ ids: batch.map(entry => entry.id), include: ['documents', 'metadatas'] })
    const positions = new Map(verified.ids.map((id, i) => [id, i]))
    for (const entry of batch) {
      const i = positions.get(entry.id)
      if (i === undefined || verified.documents[i] !== entry.document
        || JSON.stringify(Object.entries(verified.metadatas[i] ?? {}).sort()) !== JSON.stringify(Object.entries(entry.metadata).sort())) {
        throw new Error(`Chunk verification failed in ${name}: ${entry.id}`)
      }
    }
  }
  if (await collection.count() !== entries.length) throw new Error(`Chunk inventory mismatch in ${name}`)
  return { name, count: entries.length }
}
