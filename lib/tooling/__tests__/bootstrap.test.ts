import { afterEach, expect, it, vi } from 'vitest'
import { effectiveOllamaModels, requiredServices, waitUntilReady } from '../../../scripts/dev.mjs'

afterEach(() => vi.useRealTimers())

it('selects dependencies from the effective persistence and host configuration', () => {
  expect(requiredServices({})).toEqual(['chromadb'])
  expect(requiredServices({ DATABASE_URL: 'postgres://localhost/local' })).toEqual(['chromadb', 'postgres-db'])
  expect(requiredServices({ DATABASE_URL: 'postgres://remote.example/service', CHROMA_HOST: 'chroma.example' })).toEqual([])
})

it('prepares both role models and embeddings, without duplicate pulls', () => {
  expect(effectiveOllamaModels({ OLLAMA_MODEL: 'shared', EMBEDDING_MODEL: 'embed' })).toEqual(['shared', 'embed'])
  expect(effectiveOllamaModels({ OLLAMA_QUICK_MODEL: 'quick', OLLAMA_DEEP_MODEL: 'deep' })).toEqual(['quick', 'deep', 'qwen3-embedding:4b'])
  expect(effectiveOllamaModels({ LLM_PROVIDER: 'bedrock', EMBEDDING_MODEL: 'embed' })).toEqual(['embed'])
})

it('bounds failed health checks instead of waiting indefinitely', async () => {
  vi.useFakeTimers()
  const check = vi.fn().mockResolvedValue(false)
  const wait = waitUntilReady(check, { timeoutMs: 100, intervalMs: 20, label: 'Postgres' })
  const result = expect(wait).rejects.toThrow('Postgres did not become ready')
  await vi.advanceTimersByTimeAsync(100)
  await result
  expect(check).toHaveBeenCalledTimes(5)
})
