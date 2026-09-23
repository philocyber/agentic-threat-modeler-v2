import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeRagHealth, recoveryStepsForChroma } from '@/lib/health/rag-status'
import * as indexJobs from '@/lib/rag/index-job'
import { _clearEmbeddingClientState } from '@/lib/embeddings/client'

// Health fixtures must not depend on the developer's published corpus.
vi.mock('@/lib/rag/index-state', () => ({ readRAGIndexState: async () => null }))

const base = {
  chromaHost: 'localhost',
  chromaPort: 8000,
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'qwen3-embedding:0.6b',
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  _clearEmbeddingClientState()
})

function indicesWithTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rag-health-indices-'))
  writeFileSync(
    join(dir, 'doc.tree.json'),
    JSON.stringify({
      doc_name: 'sample',
      tree: [{ title: 'Intro', summary: 'Threat modeling for APIs', children: [] }],
    }),
  )
  return dir
}

function stubChromaFetch(options: {
  heartbeat?: number
  failHeartbeat?: boolean
  collections?: Array<{ id: string; name: string; count: number }>
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/embed')) {
        return Response.json({ embeddings: [[0.1, 0.2, 0.3]] })
      }
      if (url.includes('/heartbeat')) {
        if (options.failHeartbeat) throw new Error('fetch failed')
        return new Response('{}', { status: options.heartbeat ?? 200 })
      }
      if (url.includes('/collections/') && url.endsWith('/count')) {
        const id = url.split('/collections/')[1]?.replace(/\/count$/, '')
        const match = options.collections?.find((collection) => collection.id === id)
        return new Response(JSON.stringify(match?.count ?? 0), { status: 200 })
      }
      if (url.endsWith('/collections')) {
        return new Response(JSON.stringify(options.collections ?? []), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }),
  )
}

describe('probeRagHealth', () => {
  it('marks retrieval usable only when Chroma is up and there is something to retrieve', async () => {
    const pageIndicesPath = indicesWithTree()
    stubChromaFetch({
      collections: [{ id: 'col-1', name: 'tm_technical', count: 12 }],
    })
    const health = await probeRagHealth({ ...base, pageIndicesPath })
    expect(health).toMatchObject({
      status: 'up',
      usable: true,
      issue: null,
      endpoint: 'http://localhost:8000',
      documentCount: 12,
      pageIndexNodes: 1,
    })
    expect(health.recovery).toEqual([])
    expect(health.warning).toBeUndefined()
  })

  it('explains a down heartbeat and includes recovery steps', async () => {
    stubChromaFetch({ failHeartbeat: true })
    const health = await probeRagHealth({ ...base, pageIndicesPath: mkdtempSync(join(tmpdir(), 'rag-empty-')) })
    expect(health.status).toBe('down')
    expect(health.usable).toBe(false)
    expect(health.issue).toBe('chroma_unreachable')
    expect(health.reason).toContain('http://localhost:8000')
    expect(health.recovery.length).toBeGreaterThan(2)
    expect(health.recovery.join('\n')).toContain('pnpm services:up')
    expect(health.recovery.join('\n')).toContain('Next.js')
  })

  it('does not treat a heartbeat as ready when collections and page indices are empty', async () => {
    stubChromaFetch({ collections: [] })
    const health = await probeRagHealth({
      ...base,
      pageIndicesPath: mkdtempSync(join(tmpdir(), 'rag-empty-indices-')),
    })
    expect(health.status).toBe('up')
    expect(health.usable).toBe(false)
    expect(health.issue).toBe('empty_index')
    expect(health.reason).toMatch(/no non-empty vector collection/i)
  })

  it('does not let page indices replace the required non-empty vector collection', async () => {
    stubChromaFetch({ collections: [{ id: 'col-1', name: 'tm_technical', count: 0 }] })
    const health = await probeRagHealth({ ...base, pageIndicesPath: indicesWithTree() })
    expect(health.status).toBe('up')
    expect(health.usable).toBe(false)
    expect(health.issue).toBe('empty_index')
    expect(health.pageIndexNodes).toBe(1)
  })

  it('reports an unavailable embedding model after the vector gate passes', async () => {
    stubChromaFetch({ collections: [{ id: 'col-1', name: 'tm_technical', count: 1 }] })
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/embed')) return new Response('offline', { status: 503 })
      return originalFetch(input, init)
    }))
    const health = await probeRagHealth({ ...base, pageIndicesPath: indicesWithTree() })
    expect(health).toMatchObject({
      status: 'up',
      usable: false,
      issue: 'embedding_unavailable',
      documentCount: 1,
    })
  })
})

describe('recoveryStepsForChroma', () => {
  it('always offers a no-Docker Chroma command', () => {
    const steps = recoveryStepsForChroma(base)
    expect(steps.some((step) => step.includes('uvx --from chromadb'))).toBe(true)
  })
})

it.each(['running', 'failed'] as const)('blocks RAG against a %s rebuild even with populated collections', async (status) => {
  vi.spyOn(indexJobs, 'getRAGIndexJob').mockReturnValue({
    id: 'test-index', status, startedAt: null, completedAt: null, logs: [], error: null,
  })
  stubChromaFetch({ collections: [{ id: 'partial', name: 'tm_books', count: 100 }] })
  const result = await probeRagHealth(base)
  expect(result.usable).toBe(false)
  expect(result.issue).toBe(status === 'running' ? 'index_building' : 'index_incomplete')
})

it('checks published generations by name and rejects missing or partial collections', async () => {
  const { probeChromaInventory } = await import('../rag-status')
  const expected = { tm_technical: { name: 'tm_technical_published', count: 2 } }
  const request = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/tm_technical_published')) return Response.json({ id: 'published-id', name: 'tm_technical_published' })
    if (url.endsWith('/published-id/count')) return Response.json(2)
    throw new Error('Must not list or count unrelated staging collections')
  })
  vi.stubGlobal('fetch', request)
  await expect(probeChromaInventory('http://chroma', expected)).resolves.toMatchObject({ documentCount: 2 })
  request.mockImplementation(async input => String(input).endsWith('/count') ? Response.json(1) : Response.json({ id: 'published-id', name: 'tm_technical_published' }))
  await expect(probeChromaInventory('http://chroma', expected)).resolves.toMatchObject({ documentCount: null })
  request.mockImplementation(async () => new Response('', { status: 404 }))
  await expect(probeChromaInventory('http://chroma', expected)).resolves.toMatchObject({ documentCount: null })
})
