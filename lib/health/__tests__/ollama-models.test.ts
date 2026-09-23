import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeOllamaModels } from '../ollama-models'

afterEach(() => vi.unstubAllGlobals())

describe('Ollama model readiness', () => {
  it('requires both selected models and excludes embedding-only entries', async () => {
    const fetch = vi.fn(async () => Response.json({ models: [
      { name: 'qwen3:4b', capabilities: ['completion'] },
      { model: 'qwen3:8b' },
      { name: 'qwen3-embedding:4b', capabilities: ['embedding'] },
    ] }))
    vi.stubGlobal('fetch', fetch)
    expect(await probeOllamaModels('http://localhost:11434/', ['qwen3:4b', 'qwen3.5:9b'])).toEqual({
      reachable: true, ready: false, availableModels: ['qwen3:4b', 'qwen3:8b'], missingModels: ['qwen3.5:9b'],
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.objectContaining({ cache: 'no-store' }))
  })
  it('matches an untagged name only to latest, including namespaced models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ models: [{ name: 'team/qwen:latest' }] })))
    expect((await probeOllamaModels('http://localhost:11434', ['team/qwen'])).ready).toBe(true)
    expect((await probeOllamaModels('http://localhost:11434', ['qwen', 'team/qwen:4b'])).ready).toBe(false)
  })
  it.each([new Response('{}', { status: 500 }), Response.json({})])('does not claim readiness for an invalid inventory', async response => {
    vi.stubGlobal('fetch', vi.fn(async () => response))
    expect((await probeOllamaModels('http://localhost:11434', ['qwen3:4b'])).reachable).toBe(false)
  })
  it('handles an unreachable server without running inference', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused') }))
    expect(await probeOllamaModels('http://localhost:11434', ['qwen3:4b'])).toMatchObject({ reachable: false, ready: false })
  })
})
