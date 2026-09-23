import { afterEach, describe, expect, it, vi } from 'vitest'
import { _clearEmbeddingClientState, embedTextsShared, runWithEmbeddingDegradationHandler } from '../client'

afterEach(() => {
  vi.unstubAllGlobals()
  _clearEmbeddingClientState()
})

describe('shared embedding client', () => {
  it('coalesces concurrent requests for the same text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ embeddings: [[1, 2, 3]] }))
    vi.stubGlobal('fetch', fetchMock)
    const [left, right] = await Promise.all([
      embedTextsShared('http://ollama', 'embed', ['same']),
      embedTextsShared('http://ollama', 'embed', ['same']),
    ])
    expect(left).toEqual(right)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('opens the circuit after two failed batches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('offline', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const warnings: string[] = []
    await runWithEmbeddingDegradationHandler((message) => warnings.push(message), async () => {
      await expect(embedTextsShared('http://ollama', 'embed', ['one'])).rejects.toThrow()
      await expect(embedTextsShared('http://ollama', 'embed', ['two'])).rejects.toThrow()
      await expect(embedTextsShared('http://ollama', 'embed', ['three']))
        .rejects.toThrow(/circuit open/i)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warnings).toEqual([expect.stringMatching(/lexical and reviewer evidence/i)])
  })
})
