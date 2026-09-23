import {
  isLLMProvider,
  type LLMProvider,
} from '@/lib/llm/providers'

const INFERENCE_PROFILE_IDS = [
  'local_efficient',
  'provider_optimized',
  'provider_full_power',
  'adaptive_value',
] as const

export type InferenceProfileId = (typeof INFERENCE_PROFILE_IDS)[number]

const OLLAMA_PROFILE_IDS: readonly InferenceProfileId[] = [
  'local_efficient',
  'provider_full_power',
  'adaptive_value',
]

const CLOUD_PROFILE_IDS: readonly InferenceProfileId[] = [
  'provider_optimized',
  'provider_full_power',
  'adaptive_value',
]

export const INFERENCE_PROFILES: ReadonlyArray<{
  id: InferenceProfileId
  label: string
  shortLabel: string
  description: string
  route: string
}> = [
  {
    id: 'local_efficient',
    label: 'Local Efficient',
    shortLabel: 'Local',
    description: 'Keeps every phase and every retry on Ollama. No analysis context is sent to a cloud vendor.',
    route: 'Quick local model for enumeration, deep local model for adjudication and synthesis.',
  },
  {
    id: 'provider_optimized',
    label: 'Provider Optimized',
    shortLabel: 'Optimized',
    description: 'Uses the selected vendor end to end, assigning its quick and deep tiers by phase.',
    route: 'Quick tier for mechanical phases, deep tier for STRIDE, debate and synthesis.',
  },
  {
    id: 'provider_full_power',
    label: 'Provider Full Power',
    shortLabel: 'Full power',
    description: 'Runs every LLM phase with the selected vendor deep tier for maximum consistency and quality.',
    route: 'Deep tier for parser, analysts, debate, synthesis and validation.',
  },
  {
    id: 'adaptive_value',
    label: 'Adaptive Value',
    shortLabel: 'Adaptive',
    description: 'Starts with the optimized route and reserves a same-provider path for future quality-gate retries.',
    route: 'Optimized start; automatic quality-gate rerouting is not enabled yet.',
  },
]

export function isInferenceProfileId(value: unknown): value is InferenceProfileId {
  return typeof value === 'string' &&
    (INFERENCE_PROFILE_IDS as readonly string[]).includes(value)
}

export function getCompatibleInferenceProfiles(
  provider: LLMProvider,
): readonly InferenceProfileId[] {
  return provider === 'ollama' ? OLLAMA_PROFILE_IDS : CLOUD_PROFILE_IDS
}

export function getDefaultInferenceProfile(provider: LLMProvider): InferenceProfileId {
  return provider === 'ollama' ? 'local_efficient' : 'provider_optimized'
}

export function isInferenceProfileCompatible(
  provider: LLMProvider,
  profile: InferenceProfileId,
): boolean {
  return getCompatibleInferenceProfiles(provider).includes(profile)
}

export function normalizeAllowedProviders(
  value: unknown,
  primaryProvider: LLMProvider,
): LLMProvider[] {
  const requested = Array.isArray(value)
    ? value.filter(isLLMProvider)
    : []
  const unique = [...new Set(requested)]
  if (!unique.includes(primaryProvider)) unique.unshift(primaryProvider)
  return unique
}

export function normalizeAllowedProfiles(
  value: unknown,
  activeProfile: InferenceProfileId,
): InferenceProfileId[] {
  const requested = Array.isArray(value)
    ? value.filter(isInferenceProfileId)
    : []
  const unique = [...new Set(requested)]
  if (!unique.includes(activeProfile)) unique.unshift(activeProfile)
  return unique
}

export function isLocalOnlyBoundary(providers: readonly LLMProvider[]): boolean {
  return providers.length === 1 && providers[0] === 'ollama'
}

/** Keep providers with strict token-throughput limits on one batch at a time. */
export function providerBatchConcurrency(provider: string, requested = 3): number {
  return provider === 'ollama' || provider === 'kimi' ? 1 : Math.max(1, requested)
}

/**
 * Central privacy invariant for all present and future quality-gate routing.
 * A phase may never move to a provider outside the user-authorized boundary.
 */
export function canRouteToProvider(
  allowedProviders: readonly LLMProvider[],
  candidate: LLMProvider,
): boolean {
  return allowedProviders.includes(candidate)
}
