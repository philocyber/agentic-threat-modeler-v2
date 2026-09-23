import { getConfig, getModelForProviderRole, providerHasCredentials } from '@/lib/config'
import { isLLMProvider, type LLMProvider } from '@/lib/llm/providers'
import { isInferenceProfileCompatible, isInferenceProfileId, type InferenceProfileId } from '@/lib/llm/execution-profiles'
import type { AnalyzeRequest, AnalysisConfig } from '@/lib/models/types'

const ALLOWED_ANALYSTS = ['stride', 'pasta', 'attack_tree'] as const
type AllowedAnalyst = (typeof ALLOWED_ANALYSTS)[number]
const ALLOWED_EXECUTION_MODES = ['hybrid', 'parallel', 'cascade'] as const
type AllowedExecutionMode = (typeof ALLOWED_EXECUTION_MODES)[number]

export class AnalysisConfigError extends Error {}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function safeOllamaModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const model = value.trim()
  return model.length <= 120 && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/.test(model)
    ? model
    : undefined
}

export function clampAnalysisConfig(
  bodyConfig: AnalyzeRequest['config'] | undefined,
  appConfig: ReturnType<typeof getConfig>
): AnalysisConfig {
  let provider: LLMProvider = appConfig.llm.provider
  if (bodyConfig?.provider !== undefined) {
    if (!isLLMProvider(bodyConfig.provider)) {
      throw new AnalysisConfigError('Unsupported LLM provider')
    }
    if (!providerHasCredentials(bodyConfig.provider, appConfig)) {
      throw new AnalysisConfigError(
        `Provider "${bodyConfig.provider}" is not configured. Add and validate its credentials before running.`,
      )
    }
    provider = bodyConfig.provider
  }

  const executionProfile: InferenceProfileId = isInferenceProfileId(bodyConfig?.executionProfile)
    ? bodyConfig.executionProfile
    : provider === 'ollama'
      ? 'local_efficient'
      : 'provider_optimized'

  if (!isInferenceProfileCompatible(provider, executionProfile)) {
    throw new AnalysisConfigError(
      `Execution profile "${executionProfile}" is not compatible with provider "${provider}".`,
    )
  }

  if (
    bodyConfig?.allowedProviders !== undefined &&
    (!Array.isArray(bodyConfig.allowedProviders) ||
      bodyConfig.allowedProviders.length !== 1 ||
      bodyConfig.allowedProviders[0] !== provider)
  ) {
    throw new AnalysisConfigError('Select exactly one inference provider for each run.')
  }

  if (
    bodyConfig?.allowedProfiles !== undefined &&
    (!Array.isArray(bodyConfig.allowedProfiles) ||
      bodyConfig.allowedProfiles.length !== 1 ||
      bodyConfig.allowedProfiles[0] !== executionProfile)
  ) {
    throw new AnalysisConfigError('Select exactly one execution profile for each run.')
  }

  const allowedProviders: LLMProvider[] = [provider]
  const allowedProfiles: InferenceProfileId[] = [executionProfile]

  const requestedAnalysts = bodyConfig?.enabledAnalysts
  const enabledAnalysts: AllowedAnalyst[] = requestedAnalysts
    ? (requestedAnalysts.filter((a): a is AllowedAnalyst =>
        (ALLOWED_ANALYSTS as readonly string[]).includes(a)
      ) as AllowedAnalyst[])
    : (appConfig.pipeline.enabledAnalysts as AllowedAnalyst[])

  const executionMode: AllowedExecutionMode =
    bodyConfig?.executionMode &&
    (ALLOWED_EXECUTION_MODES as readonly string[]).includes(bodyConfig.executionMode)
      ? (bodyConfig.executionMode as AllowedExecutionMode)
      : (appConfig.pipeline.executionMode as AllowedExecutionMode)

  // Cloud model IDs remain server-controlled to prevent cost amplification.
  // Ollama model IDs may be selected from the local UI after strict syntax and
  // length validation because they never address a remote vendor endpoint.
  const providerQuickModel = provider === 'ollama'
    ? safeOllamaModel(bodyConfig?.quickModel) ?? getModelForProviderRole(provider, 'quick', appConfig)
    : getModelForProviderRole(provider, 'quick', appConfig)
  const deepModel = provider === 'ollama'
    ? safeOllamaModel(bodyConfig?.deepModel) ?? getModelForProviderRole(provider, 'deep', appConfig)
    : getModelForProviderRole(provider, 'deep', appConfig)
  const quickModel = executionProfile === 'provider_full_power'
    ? deepModel
    : providerQuickModel

  return {
    provider,
    allowedProviders,
    executionProfile,
    allowedProfiles,
    quickModel,
    deepModel,
    enabledAnalysts: enabledAnalysts.length > 0 ? enabledAnalysts : (['stride'] as AllowedAnalyst[]),
    executionMode,
    maxDebateRounds: clamp(
      bodyConfig?.maxDebateRounds ?? appConfig.pipeline.maxDebateRounds,
      1,
      5
    ),
    targetThreats: clamp(
      bodyConfig?.targetThreats ?? appConfig.pipeline.targetThreats,
      1,
      50
    ),
    requireEvidenceForHighPriority:
      bodyConfig?.requireEvidenceForHighPriority ??
      appConfig.pipeline.requireEvidenceForHighPriority,
    useRag: bodyConfig?.useRag !== false,
  }
}

