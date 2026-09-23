import { describe, expect, it } from 'vitest'
import {
  canRouteToProvider,
  getCompatibleInferenceProfiles,
  getDefaultInferenceProfile,
  isInferenceProfileCompatible,
  isLocalOnlyBoundary,
  normalizeAllowedProfiles,
  normalizeAllowedProviders,
  providerBatchConcurrency,
} from '@/lib/llm/execution-profiles'

describe('inference routing boundaries', () => {
  it('never permits a cloud provider for an Ollama-only boundary', () => {
    const allowed = normalizeAllowedProviders(['ollama'], 'ollama')

    expect(isLocalOnlyBoundary(allowed)).toBe(true)
    expect(canRouteToProvider(allowed, 'ollama')).toBe(true)
    expect(canRouteToProvider(allowed, 'kimi')).toBe(false)
    expect(canRouteToProvider(allowed, 'google')).toBe(false)
    expect(canRouteToProvider(allowed, 'bedrock')).toBe(false)
  })

  it('keeps the primary provider inside the authorized boundary', () => {
    expect(normalizeAllowedProviders(['google'], 'kimi')).toEqual(['kimi', 'google'])
  })

  it('keeps the active profile inside the permitted profile set', () => {
    expect(normalizeAllowedProfiles(['provider_optimized'], 'provider_full_power')).toEqual([
      'provider_full_power',
      'provider_optimized',
    ])
  })

  it('offers only provider-compatible execution profiles', () => {
    expect(getCompatibleInferenceProfiles('ollama')).toEqual([
      'local_efficient',
      'provider_full_power',
      'adaptive_value',
    ])
    expect(getCompatibleInferenceProfiles('kimi')).toEqual([
      'provider_optimized',
      'provider_full_power',
      'adaptive_value',
    ])
    expect(isInferenceProfileCompatible('kimi', 'local_efficient')).toBe(false)
    expect(isInferenceProfileCompatible('ollama', 'provider_optimized')).toBe(false)
  })

  it('selects a safe default profile for each provider boundary', () => {
    expect(getDefaultInferenceProfile('ollama')).toBe('local_efficient')
    expect(getDefaultInferenceProfile('google')).toBe('provider_optimized')
    expect(getDefaultInferenceProfile('kimi')).toBe('provider_optimized')
    expect(getDefaultInferenceProfile('bedrock')).toBe('provider_optimized')
  })

  it('serializes batch-heavy work for local and token-limited providers', () => {
    expect(providerBatchConcurrency('ollama', 3)).toBe(1)
    expect(providerBatchConcurrency('kimi', 3)).toBe(1)
    expect(providerBatchConcurrency('cursor', 3)).toBe(3)
  })
})
