import { resolveHostedContextCapacity, CONTEXT_CATALOG_VERSION } from './context-capacity'
import { CancellableChatOllama as ChatOllama } from './cancellable-ollama'
import { CancellableChatGoogleGenerativeAI as ChatGoogleGenerativeAI } from './cancellable-gemini'
import { ChatOpenAI } from '@langchain/openai'
import { ChatBedrockConverse } from '@langchain/aws'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { AppConfig } from '@/lib/config'
import { getModelForProviderRole, getOllamaModelForRole, isAllowedKimiBaseUrl } from '@/lib/config'
import type { LLMProvider, LLMRole } from '@/lib/llm/providers'
import { getBedrockCredentials, getBedrockModelId, getBedrockInferenceProfile } from '@/lib/llm/bedrock'
import { ChatCursorGrok } from '@/lib/llm/cursor'

type CacheKey = string

const _cache = new Map<CacheKey, BaseChatModel>()

function credentialsFingerprint(config: AppConfig): string {
  const llm = config.llm
  // Length + last 4 chars only — enough to bust the cache on rotation without logging secrets.
  const tip = (v: string | undefined) => (v ? `${v.length}:${v.slice(-4)}` : '0')
  switch (llm.provider) {
    case 'google':
      return `g:${tip(llm.googleApiKey)}`
    case 'kimi':
      return `k:${tip(llm.kimiApiKey)}:${llm.kimiBaseUrl}`
    case 'bedrock':
      return `b:${llm.bedrockRegion}:${tip(llm.bedrockAccessKeyId)}:${tip(llm.bedrockSecretAccessKey)}:${tip(llm.bedrockSessionToken)}:${llm.bedrockInferenceProfile ?? ''}`
    case 'cursor':
      return `c:${tip(llm.cursorApiKey)}:${llm.cursorQuickModel}:${llm.cursorDeepModel}:${llm.cursorQuickFast ? '1' : '0'}`
    case 'ollama':
    default:
      return `o:${llm.ollamaBaseUrl}`
  }
}

function cacheKey(
  config: AppConfig,
  role: LLMRole,
  jsonMode: boolean,
  modelOverride?: string,
  temperatureOverride?: number,
): CacheKey {
  const model =
    modelOverride ?? getModelForProviderRole(config.llm.provider, role, config)
  const temperatureKey = config.llm.provider === 'cursor' ? 'unsupported' : temperatureOverride ?? 'default'
  const sizing = [config.llm.ollamaQuickNumCtx, config.llm.ollamaDeepNumCtx, config.llm.ollamaQuickMaxTokens, config.llm.ollamaDeepMaxTokens, config.llm.geminiQuickMaxTokens, config.llm.geminiDeepMaxTokens, config.llm.kimiQuickMaxTokens, config.llm.kimiDeepMaxTokens, config.llm.bedrockQuickMaxTokens, config.llm.bedrockDeepMaxTokens].join(',')
  return `${CONTEXT_CATALOG_VERSION}:${sizing}:${config.llm.provider}:${role}:${model}:${jsonMode}:${temperatureKey}:${credentialsFingerprint(config)}:${process.env.MODEL_CONTEXT_WINDOWS ?? ''}`
}

// ─── Ollama ──────────────────────────────────────────────────────────────────

function makeOllamaModel(
  config: AppConfig,
  role: LLMRole,
  jsonMode: boolean,
  modelOverride?: string,
  temperatureOverride?: number,
): BaseChatModel {
  const modelName = modelOverride ?? getOllamaModelForRole(role, config)
  const temperature = temperatureOverride ?? (role === 'deep' ? 0.2 : 0.3)

  const options: ConstructorParameters<typeof ChatOllama>[0] = {
    baseUrl: config.llm.ollamaBaseUrl,
    model: modelName,
    temperature,
    numCtx:
      role === 'deep' || role === 'stride'
        ? config.llm.ollamaDeepNumCtx
        : config.llm.ollamaQuickNumCtx,
    numPredict:
      role === 'deep' || role === 'stride'
        ? config.llm.ollamaDeepMaxTokens
        : config.llm.ollamaQuickMaxTokens,
    think: false,
    // Native JSON mode: guarantees syntactically valid JSON. Schema-level
    // enforcement is per-call via invokeStructured() (lib/llm/structured.ts).
    ...(jsonMode ? { format: 'json' } : {}),
  }
  const instance = new ChatOllama(options) as ChatOllama & {
    contextWindow: number
    outputTokenReserve: number
  }
  instance.contextWindow = options.numCtx!
  instance.outputTokenReserve = Math.min(options.numPredict!, Math.max(1_024, Math.floor(options.numCtx! * 0.25)))
  return instance
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

function makeGeminiModel(config: AppConfig, role: LLMRole, jsonMode: boolean, modelOverride?: string, temperatureOverride?: number): BaseChatModel {
  if (!config.llm.googleApiKey) {
    throw new Error('GOOGLE_API_KEY is not set. Cannot use Google Gemini provider.')
  }

  const modelName = modelOverride ?? getModelForProviderRole('google', role, config)
  const usesCurrentSamplingContract = /^gemini-3\.(?:5|6)(?:-|$)/.test(modelName)

  const options: ConstructorParameters<typeof ChatGoogleGenerativeAI>[0] = {
    maxRetries: 0,
    apiKey: config.llm.googleApiKey,
    model: modelName,
    ...(!usesCurrentSamplingContract
      ? { temperature: temperatureOverride ?? (role === 'deep' ? 0.2 : 0.3) }
      : {}),
    maxOutputTokens:
      role === 'deep' || role === 'stride'
        ? config.llm.geminiDeepMaxTokens
        : config.llm.geminiQuickMaxTokens,
  }

  // jsonMode is a documented no-op for Gemini: its structured output is applied
  // per-call via invokeStructured() / withStructuredOutput() (see
  // lib/llm/structured.ts), not at model construction time.
  void jsonMode
  return new ChatGoogleGenerativeAI(options)
}

// ─── Kimi / Moonshot (OpenAI-compatible) ─────────────────────────────────────

function makeKimiModel(config: AppConfig, role: LLMRole, jsonMode: boolean, modelOverride?: string, temperatureOverride?: number): BaseChatModel {
  if (!config.llm.kimiApiKey) {
    throw new Error(
      'MOONSHOT_API_KEY (or KIMI_API_KEY) is not set. Cannot use Kimi provider.'
    )
  }
  if (!isAllowedKimiBaseUrl(config.llm.kimiBaseUrl)) {
    throw new Error(
      `KIMI_BASE_URL "${config.llm.kimiBaseUrl}" is not an approved Moonshot API endpoint.`
    )
  }

  const modelName = modelOverride ?? getModelForProviderRole('kimi', role, config)
  const maxTokens =
    role === 'deep' || role === 'stride'
      ? config.llm.kimiDeepMaxTokens
      : config.llm.kimiQuickMaxTokens

  const isK3 = modelName === 'kimi-k3' || modelName.startsWith('kimi-k3-')
  const isK2ReasoningFamily = /^kimi-k2\.(?:5|6)(?:-|$)/.test(modelName)
  const usesCurrentKimiContract = isK3 || isK2ReasoningFamily
  const modelKwargs: Record<string, unknown> = usesCurrentKimiContract
    ? {
        max_completion_tokens: maxTokens,
        ...(isK3
          ? { reasoning_effort: role === 'deep' || role === 'stride' ? 'high' : 'low' }
          : { thinking: { type: 'disabled' } }),
      }
    : {}

  // Structured output is applied per call by invokeStructured(). Keeping a
  // constructor-level response_format would override its json_schema request.
  void jsonMode

  return new ChatOpenAI({
    // Shared agent retries classify billing failures; SDK retries would hide and repeat them.
    maxRetries: 0,
    apiKey: config.llm.kimiApiKey,
    model: modelName,
    ...(!usesCurrentKimiContract
      ? { temperature: temperatureOverride ?? (role === 'deep' ? 0.2 : 0.3) }
      : {}),
    maxTokens: usesCurrentKimiContract ? -1 : maxTokens,
    modelKwargs,
    configuration: {
      baseURL: config.llm.kimiBaseUrl,
    },
  })
}

// ─── AWS Bedrock ──────────────────────────────────────────────────────────────

function makeBedrockModel(config: AppConfig, role: LLMRole, jsonMode: boolean, modelOverride?: string, temperatureOverride?: number): BaseChatModel {
  const modelName = modelOverride ?? getBedrockModelId(config, role)
  const maxTokens =
    role === 'deep' || role === 'stride'
      ? config.llm.bedrockDeepMaxTokens
      : config.llm.bedrockQuickMaxTokens

  const credentials = getBedrockCredentials(config)

  // jsonMode is a documented no-op for Bedrock: the Converse API has no plain
  // JSON mode; structured output is tool-use with forced toolChoice, applied
  // per-call via invokeStructured() (lib/llm/structured.ts).
  void jsonMode

  const inferenceProfile = getBedrockInferenceProfile(config)

  return new ChatBedrockConverse({
    maxRetries: 0,
    clientOptions: { maxAttempts: 1 },
    // Always the real per-role model id (not the profile ARN) so LangChain's
    // tool-choice/model-family detection (which pattern-matches on `model`)
    // keeps working correctly even when routing through an inference profile.
    model: modelName,
    region: config.llm.bedrockRegion,
    temperature: temperatureOverride ?? (role === 'deep' ? 0.2 : 0.3),
    maxTokens,
    ...(credentials ? { credentials } : {}),
    ...(inferenceProfile ? { applicationInferenceProfile: inferenceProfile } : {}),
  })
}

// ─── Cursor SDK (Grok 4.7 default) ───────────────────────────────────────────

function makeCursorModel(config: AppConfig, role: LLMRole, jsonMode: boolean, modelOverride?: string): BaseChatModel {
  if (!config.llm.cursorApiKey) {
    throw new Error('CURSOR_API_KEY is not set. Cannot use Cursor SDK provider.')
  }
  const modelName = modelOverride ?? getModelForProviderRole('cursor', role, config)
  const useFast = role === 'quick' && config.llm.cursorQuickFast
  return new ChatCursorGrok({
    apiKey: config.llm.cursorApiKey,
    model: modelName,
    useFast,
    jsonMode,
  })
}

// ─── Public factory ──────────────────────────────────────────────────────────

export function getLLM(
  config: AppConfig,
  role: LLMRole,
  jsonMode = false,
  modelOverride?: string,
  temperatureOverride?: number,
): BaseChatModel {
  const key = cacheKey(config, role, jsonMode, modelOverride, temperatureOverride)

  if (_cache.has(key)) return _cache.get(key)!

  let model: BaseChatModel
  const provider: LLMProvider = config.llm.provider

  switch (provider) {
    case 'google':
      model = makeGeminiModel(config, role, jsonMode, modelOverride, temperatureOverride)
      break
    case 'kimi':
      model = makeKimiModel(config, role, jsonMode, modelOverride, temperatureOverride)
      break
    case 'bedrock':
      model = makeBedrockModel(config, role, jsonMode, modelOverride, temperatureOverride)
      break
    case 'cursor':
      model = makeCursorModel(config, role, jsonMode, modelOverride)
      break
    case 'ollama':
    default:
      model = makeOllamaModel(config, role, jsonMode, modelOverride, temperatureOverride)
      break
  }

  ;(model as BaseChatModel & { providerName: LLMProvider }).providerName = provider

  // Exact model-name overrides avoid applying one model's capacity to another.
  // Unlisted hosted models use a conservative planning window, not a vendor claim.
  if (provider !== 'ollama') {
    const name = modelOverride ?? getModelForProviderRole(provider, role, config)
    const capacity = resolveHostedContextCapacity(provider, name)
    const aware = model as BaseChatModel & { contextWindow: number; outputTokenReserve: number; contextCapacitySource: string }
    aware.contextWindow = capacity.contextWindow
    aware.contextCapacitySource = capacity.source
    const deep = role === 'deep' || role === 'stride'
    const caps = provider === 'google' ? [config.llm.geminiQuickMaxTokens, config.llm.geminiDeepMaxTokens]
      : provider === 'kimi' ? [config.llm.kimiQuickMaxTokens, config.llm.kimiDeepMaxTokens]
      : provider === 'bedrock' ? [config.llm.bedrockQuickMaxTokens, config.llm.bedrockDeepMaxTokens] : [8192, 16384]
    aware.outputTokenReserve = caps[deep ? 1 : 0]!
  }
  _cache.set(key, model)
  return model
}

export function clearLLMCache(): void {
  _cache.clear()
}

export function getModelDisplayName(
  config: AppConfig,
  role: LLMRole,
  modelOverride?: string
): string {
  if (config.llm.provider === 'ollama' && modelOverride) return modelOverride
  return getModelForProviderRole(config.llm.provider, role, config)
}

export function isUsingGemini(config: AppConfig): boolean {
  return config.llm.provider === 'google'
}

export function getProviderName(config: AppConfig): LLMProvider {
  return config.llm.provider
}
