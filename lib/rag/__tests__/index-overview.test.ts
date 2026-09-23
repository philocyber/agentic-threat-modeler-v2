import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from '@/app/api/v1/index/route'
import { probeChromaInventory } from '@/lib/health/rag-status'
import { getRAGIndexJob, startRAGIndexJob } from '@/lib/rag/index-job'

vi.mock('@/lib/local-route', () => ({ localRoute: (fn: unknown) => fn, localAdministrationRoute: (fn: unknown) => fn }))
vi.mock('@/lib/config', () => ({ getConfig: () => ({ rag: { embeddingModel: 'test', chromaHost: 'localhost', chromaPort: 8000 } }) }))
vi.mock('@/lib/health/rag-status', () => ({ probeChromaInventory: vi.fn() }))
vi.mock('@/lib/rag/index-job', () => ({
  getRAGIndexJob: vi.fn(() => ({ status: 'idle', logs: [] })),
  startRAGIndexJob: vi.fn(() => ({ started: true, job: { status: 'running' } })),
}))
vi.mock('@/lib/rag/index-state', () => ({
  getRAGIndexReadiness: async () => ({
    readiness: { indexedAt: '2026-09-08', needsReindex: false, reason: 'up-to-date', sourceCount: 38 },
    snapshot: { sourceCount: 38 }, state: { collections: { tm_technical: { name: 'published', count: 500 } }, embeddingModel: 'test', indexedAt: '2026-09-08T12:00:00.000Z' },
  }),
  writeRAGIndexState: vi.fn(),
}))
const context = { params: Promise.resolve({}) }
beforeEach(() => vi.clearAllMocks())

it('permits rebuilding unchanged files after Chroma loses its collections', async () => {
  vi.mocked(probeChromaInventory).mockResolvedValue({ documentCount: 0, collectionNames: [] })
  const response = await GET(new NextRequest('http://localhost/api/v1/index'), context)
  expect((await response.json()).index).toMatchObject({ needsReindex: true, reason: 'vector-index-empty' })
  const rebuild = await POST(new NextRequest('http://localhost/api/v1/index', { method: 'POST' }), context)
  expect(rebuild.status).toBe(202)
  expect(startRAGIndexJob).toHaveBeenCalledOnce()
})

it('does not claim an unverified vector store is up to date', async () => {
  vi.mocked(probeChromaInventory).mockResolvedValue({ documentCount: null, collectionNames: [] })
  const response = await GET(new NextRequest('http://localhost/api/v1/index'), context)
  expect((await response.json()).index).toMatchObject({ needsReindex: true, reason: 'vector-index-unavailable' })
})

it('keeps a populated, unchanged index up to date without starting a rebuild', async () => {
  vi.mocked(probeChromaInventory).mockResolvedValue({ documentCount: 500, collectionNames: ['technical'] })
  const response = await POST(new NextRequest('http://localhost/api/v1/index', { method: 'POST' }), context)
  expect(response.status).toBe(409)
  expect((await response.json()).index.reason).toBe('up-to-date')
  expect(startRAGIndexJob).not.toHaveBeenCalled()
})

it.each(['running', 'failed'] as const)('does not mark a %s rebuild up to date after partial writes', async (status) => {
  vi.mocked(getRAGIndexJob).mockReturnValueOnce({ id: 'job', status, startedAt: null, completedAt: null, error: null, logs: [] })
  vi.mocked(probeChromaInventory).mockResolvedValue({ documentCount: 500, collectionNames: ['technical'] })
  const response = await GET(new NextRequest('http://localhost/api/v1/index'), context)
  expect((await response.json()).index).toMatchObject({ needsReindex: true, reason: 'vector-index-incomplete' })
})

it('accepts a successful CLI rebuild after a failed UI job', async () => {
  vi.mocked(getRAGIndexJob).mockReturnValueOnce({ id: 'old-job', status: 'failed', startedAt: '2026-09-07T12:00:00.000Z', completedAt: null, error: 'old failure', logs: [] })
  vi.mocked(probeChromaInventory).mockResolvedValue({ documentCount: 500, collectionNames: ['technical'] })
  const response = await GET(new NextRequest('http://localhost/api/v1/index'), context)
  expect((await response.json()).index).toMatchObject({ needsReindex: false, reason: 'up-to-date' })
})
