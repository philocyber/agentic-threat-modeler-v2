import { describe, expect, it, vi } from 'vitest'
import type { ChromaClient } from 'chromadb'
import { buildIndexGeneration, type PreparedIndexEntry } from '../generation'

function fixture() {
  const rows = new Map<string, { document: string; metadata: Record<string, unknown> }>()
  const collection = {
    metadata: { embeddingModel: 'fixture' },
    get: vi.fn(async ({ ids }: { ids: string[] }) => {
      const found = ids.filter(id => rows.has(id))
      return { ids: found, documents: found.map(id => rows.get(id)!.document), metadatas: found.map(id => rows.get(id)!.metadata) }
    }),
    upsert: vi.fn(async (batch: { ids: string[]; documents: string[]; metadatas: Record<string, unknown>[] }) => {
      batch.ids.forEach((id, i) => rows.set(id, { document: batch.documents[i]!, metadata: batch.metadatas[i]! }))
    }),
    count: vi.fn(async () => rows.size),
  }
  const client = { getOrCreateCollection: vi.fn(async () => collection) } as unknown as ChromaClient
  const entries: PreparedIndexEntry[] = Array.from({ length: 17 }, (_, i) => ({ id: String(i), document: `source ${i}`, input: `complete context ${i}`, metadata: { source: 'fixture.md' } }))
  return { client, collection, entries }
}

describe('verified index generations', () => {
  it('resumes completed batches after a failure and verifies stored text and metadata', async () => {
    const { client, collection, entries } = fixture()
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    embed.mockRejectedValueOnce(new Error('unavailable'))
    await expect(buildIndexGeneration({ client, entries, name: 'staging', model: 'fixture', embed })).rejects.toThrow('unavailable')
    expect(collection.upsert).not.toHaveBeenCalled()
    embed.mockImplementationOnce(async texts => texts.map(() => [1, 0])).mockRejectedValueOnce(new Error('second batch failed'))
    await expect(buildIndexGeneration({ client, entries, name: 'staging', model: 'fixture', embed })).rejects.toThrow('second batch')
    embed.mockClear()
    await expect(buildIndexGeneration({ client, entries, name: 'staging', model: 'fixture', embed })).resolves.toEqual({ name: 'staging', count: 17 })
    expect(embed).toHaveBeenCalledTimes(1)
    expect(embed.mock.calls[0]![0]).toEqual(['complete context 16'])
  })

  it('rejects a successful write response that did not actually store a chunk', async () => {
    const { client, collection, entries } = fixture()
    collection.upsert.mockImplementation(async () => {})
    await expect(buildIndexGeneration({ client, entries, name: 'staging', model: 'fixture', embed: async texts => texts.map(() => [1]) })).rejects.toThrow('verification failed')
  })

  it('rejects duplicate source IDs before writing', async () => {
    const { client, entries } = fixture()
    await expect(buildIndexGeneration({ client, entries: [entries[0]!, entries[0]!], name: 'staging', model: 'fixture', embed: vi.fn() })).rejects.toThrow('Duplicate')
    expect(client.getOrCreateCollection).not.toHaveBeenCalled()
  })
})
