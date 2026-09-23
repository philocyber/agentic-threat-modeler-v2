import type { AppConfig } from '@/lib/config'
import type { LLMRole } from '@/lib/llm/providers'
import { getModelForProviderRole } from '@/lib/config'

export function getBedrockCredentials(config: AppConfig) {
  const accessKeyId = config.llm.bedrockAccessKeyId
  const secretAccessKey = config.llm.bedrockSecretAccessKey

  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      'BEDROCK_AWS_ACCESS_KEY_ID and BEDROCK_AWS_SECRET_ACCESS_KEY must be set together.'
    )
  }

  if (!accessKeyId || !secretAccessKey) return undefined
  return {
    accessKeyId,
    secretAccessKey,
    ...(config.llm.bedrockSessionToken ? { sessionToken: config.llm.bedrockSessionToken } : {}),
  }
}

/**
 * The real per-role model id (e.g. an Anthropic model ARN/id), independent of
 * whether an inference profile is configured. Callers that need the identifier
 * to hand to LangChain's `model` field (for correct tool-choice/model-family
 * detection) should use this rather than folding the profile in here.
 */
export function getBedrockModelId(config: AppConfig, role: LLMRole): string {
  return getModelForProviderRole('bedrock', role, config)
}

/** Optional Application Inference Profile ARN, if configured. */
export function getBedrockInferenceProfile(config: AppConfig): string | undefined {
  return config.llm.bedrockInferenceProfile
}

/**
 * The identifier to actually pass as `modelId` to the raw Bedrock Runtime SDK
 * (`ConverseCommand`), which accepts either a model id or an inference profile
 * ARN in that single field.
 */
export function getBedrockConverseModelId(config: AppConfig, role: LLMRole): string {
  return getBedrockInferenceProfile(config) ?? getBedrockModelId(config, role)
}
