import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '@/lib/config'
import { CorporateRAGStore } from '../corporate-store'

const mocks = vi.hoisted(() => ({
  publish: vi.fn(), upsert: vi.fn(), count: vi.fn(), embed: vi.fn(),
  get: vi.fn(), create: vi.fn(),
}))
vi.mock('chromadb', () => ({ ChromaClient: class { getOrCreateCollection = mocks.create; getCollection = mocks.get } }))
vi.mock('@/lib/embeddings/client', () => ({ createOllamaBatchEmbedFn: () => mocks.embed }))
vi.mock('../global-corpus', () => ({
  loadGlobalCorpusDocuments: async () => [{ path: 'grants.md', sha256: 'v1', content: 'Grants unknown', sourceType: 'configuration' }],
  chunkGlobalDocument: () => [{ path: 'grants.md', sha256: 'v1', text: 'Grants unknown', sectionPath: 'Grants', qualification: '', metadata: {}, sourceType: 'configuration', chunkIndex: 0, start: 0, end: 14 }],
}))
const config = { rag: { chromaHost: 'localhost', chromaPort: 8000, knowledgeBasePath: '/fixture', embeddingModel: 'test' } } as AppConfig

beforeEach(() => {
  vi.resetAllMocks()
  mocks.embed.mockResolvedValue([[1, 0]])
  mocks.count.mockResolvedValue(1)
  let rows: { ids: string[]; documents: string[]; metadatas: Array<Record<string, unknown>> } = { ids: [], documents: [], metadatas: [] }
  mocks.upsert.mockImplementation(async (batch) => { rows = batch })
  const collection = { name: 'staged-corporate', metadata: { embeddingModel: 'test' }, upsert: mocks.upsert, count: mocks.count, get: async () => rows }
  mocks.get.mockResolvedValue(collection)
  mocks.create.mockImplementation(async ({ name }: { name: string }) => name === 'tm_corporate'
    ? { metadata: { activeCollection: 'previous-generation' }, modify: mocks.publish }
    : collection)
})

describe('corporate generation publication', () => {
  it('stages verified corporate chunks without independently publishing a pointer', async () => {
    const store = new CorporateRAGStore(config)
    await store.init({ rebuild: true })
    expect(store.isAvailable()).toBe(true)
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(await store.publishedCollection()).toEqual({ name: 'staged-corporate', count: 1 })
    expect(mocks.count.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.upsert.mock.invocationCallOrder[0]!)
  })
  it('leaves the published pointer untouched after an embedding failure', async () => {
    mocks.embed.mockRejectedValue(new Error('Ollama unavailable'))
    const store = new CorporateRAGStore(config)
    await store.init({ rebuild: true })
    expect(store.isAvailable()).toBe(false)
    expect(mocks.publish).not.toHaveBeenCalled()
  })
  it('does not publish an incomplete generation', async () => {
    mocks.count.mockResolvedValue(0)
    const store = new CorporateRAGStore(config)
    await store.init({ rebuild: true })
    expect(store.isAvailable()).toBe(false)
    expect(mocks.publish).not.toHaveBeenCalled()
  })
})
