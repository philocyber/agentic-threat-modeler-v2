import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  embedWithOllama,
  isMissingOllamaModelError,
  OllamaApiError,
  pullOllamaModel,
} from '../ollama-api'

describe('Ollama API helpers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('preserves the Ollama error body and identifies a missing model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'model "nomic-embed-text" not found, try pulling it first' }),
      { status: 404, statusText: 'Not Found' },
    )))

    const error = await embedWithOllama('http://localhost:11434/', 'nomic-embed-text', ['test'])
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(OllamaApiError)
    expect(error).toMatchObject({ status: 404, detail: 'model "nomic-embed-text" not found, try pulling it first' })
    expect(isMissingOllamaModelError(error)).toBe(true)
    expect((error as Error).message).toContain('nomic-embed-text')
  })

  it('returns validated batch embeddings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ embeddings: [[1, 2], [3, 4]] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(embedWithOllama('http://localhost:11434/', 'embed-model', ['one', 'two']))
      .resolves.toEqual([[1, 2], [3, 4]])
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/embed', expect.any(Object))
  })

  it('sends complete Unicode inputs and qualifications beyond the former cutoff', async () => {
    const prefix = 'Architecture context. '.repeat(150)
    const texts = [prefix + 'Control ENABLED: autorización 🔒', prefix + 'Control DISABLED: autorización 🔓']
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ embeddings: [[1, 0], [0, 1]] }))
    vi.stubGlobal('fetch', fetchMock)
    await embedWithOllama('http://localhost:11434', 'qwen3-embedding:4b', texts)
    const request = fetchMock.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({ model: 'qwen3-embedding:4b', input: texts, truncate: false })
  })

  it('surfaces context overflow without retrying a shortened input', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: 'input length exceeds maximum context length' }, { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(embedWithOllama('http://localhost:11434', 'qwen3-embedding:4b', ['long source '.repeat(1000)]))
      .rejects.toMatchObject({ status: 400, detail: 'input length exceeds maximum context length' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('adds the recommended retrieval instruction only for Qwen3 Embedding', async () => {
    const { formatOllamaRetrievalQuery } = await import('../ollama-api')
    expect(formatOllamaRetrievalQuery('qwen3-embedding:4b', 'find SSRF guidance'))
      .toContain('Instruct: Given a cybersecurity analysis query')
    expect(formatOllamaRetrievalQuery('nomic-embed-text', 'find SSRF guidance'))
      .toBe('find SSRF guidance')
  })

  it.each([[[1, 2], [3]], [[], []], [[1, null], [1, 2]], [[1, '2'], [1, 2]]])('rejects malformed embedding vectors: %j', async (...vectors) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ embeddings: vectors })))
    await expect(embedWithOllama('http://localhost:11434', 'fixture', ['one', 'two'])).rejects.toThrow('mismatched embeddings')
  })

  it('consumes streamed model-pull progress', async () => {
    const stream = [
      JSON.stringify({ status: 'pulling manifest' }),
      JSON.stringify({ status: 'downloading', completed: 5, total: 10 }),
      JSON.stringify({ status: 'success' }),
    ].join('\n') + '\n'
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream))
    vi.stubGlobal('fetch', fetchMock)
    const statuses: string[] = []

    await expect(pullOllamaModel(
      'http://localhost:11434',
      'nomic-embed-text',
      ({ status }) => statuses.push(status),
    )).resolves.toBeUndefined()
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({ model: 'nomic-embed-text', stream: true })
    expect(statuses).toEqual(['pulling manifest', 'downloading', 'success'])
  })
})
