import type { LLMProvider } from './providers'

export const CONTEXT_CATALOG_VERSION = 'cursor-grok-47-v3'
// Exact API IDs only. Kimi capacities use its published model catalog.
// Cursor documents a 256k standard context for Grok 4.7 at
// https://cursor.com/docs/models/grok-4-7. Keep 4.6 for saved runs and overrides.
// Use 1,000,000 conservatively for K3 and 256,000 for Cursor's standard window.
const VERIFIED: Partial<Record<LLMProvider, Record<string, number>>> = {
  kimi: { 'kimi-k2.6': 262_144, 'kimi-k3': 1_000_000 },
  cursor: { 'grok-4.7': 256_000, 'grok-4.6': 256_000 },
}

export function resolveHostedContextCapacity(provider: LLMProvider, model: string, overrides = process.env.MODEL_CONTEXT_WINDOWS ?? '{}') {
  const windows: unknown = JSON.parse(overrides)
  if (!windows || typeof windows !== 'object' || Array.isArray(windows)) throw new Error('MODEL_CONTEXT_WINDOWS must be a JSON object keyed by exact model name')
  const value = (windows as Record<string, unknown>)[model]
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 4096)) throw new Error(`Invalid MODEL_CONTEXT_WINDOWS capacity for ${model}`)
  if (value !== undefined) return { contextWindow: Number(value), source: 'override' as const }
  const verified = VERIFIED[provider]?.[model]
  return verified ? { contextWindow: verified, source: 'verified_catalog' as const }
    : { contextWindow: 32_768, source: 'conservative_fallback' as const }
}

/** Unknown hosted capacity must be resolved before a large request incurs inference cost. */
export function unresolvedLargeInputModels(provider: LLMProvider, models: string[], inputCharacters: number): string[] {
  if (provider === 'ollama') return []
  return [...new Set(models)].filter(model => {
    const capacity = resolveHostedContextCapacity(provider, model)
    return inputCharacters > 18_000 && capacity.source === 'conservative_fallback'
  })
}
