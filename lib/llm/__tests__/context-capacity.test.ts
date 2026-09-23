import { describe, expect, it } from 'vitest'
import { resolveHostedContextCapacity, unresolvedLargeInputModels } from '../context-capacity'

describe('verified context capacities', () => {
  it('uses verified exact Kimi model IDs instead of the 32K fallback', () => {
    expect(resolveHostedContextCapacity('kimi', 'kimi-k2.6', '{}')).toEqual({ contextWindow: 262144, source: 'verified_catalog' })
    expect(resolveHostedContextCapacity('kimi', 'kimi-k3', '{}')).toEqual({ contextWindow: 1000000, source: 'verified_catalog' })
    expect(resolveHostedContextCapacity('cursor', 'grok-4.7', '{}')).toEqual({ contextWindow: 256000, source: 'verified_catalog' })
    expect(resolveHostedContextCapacity('cursor', 'grok-4.6', '{}')).toEqual({ contextWindow: 256000, source: 'verified_catalog' })
    expect(resolveHostedContextCapacity('google', 'kimi-k3', '{}').source).toBe('conservative_fallback')
    expect(resolveHostedContextCapacity('kimi', 'kimi-k3-future', '{}').source).toBe('conservative_fallback')
  })
  it('respects explicit lower deployment capacities and rejects invalid overrides', () => {
    expect(resolveHostedContextCapacity('kimi', 'kimi-k3', '{"kimi-k3":65536}')).toEqual({ contextWindow: 65536, source: 'override' })
    for (const value of ['null', '[]', '{"kimi-k3":-1}', '{"kimi-k3":"1000000"}']) expect(() => resolveHostedContextCapacity('kimi', 'kimi-k3', value)).toThrow()
  })
  it('requires capacity configuration for unknown hosted models on large inputs only', () => {
    expect(unresolvedLargeInputModels('kimi', ['kimi-k2.6', 'kimi-k3'], 63353)).toEqual([])
    expect(unresolvedLargeInputModels('kimi', ['unknown-model'], 63353)).toEqual(['unknown-model'])
    expect(unresolvedLargeInputModels('kimi', ['unknown-model'], 10000)).toEqual([])
    expect(unresolvedLargeInputModels('ollama', ['unknown-model'], 63353)).toEqual([])
  })
})
