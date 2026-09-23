import { z } from 'zod'
import { DEFAULT_PROVIDER_MODELS, LLM_PROVIDERS, type LLMProvider, type LLMRole } from '@/lib/llm/providers'

const EnvBooleanSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value

  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off' || normalized === '') return false

  return value
}, z.boolean())

const ALLOWED_KIMI_BASE_URLS = new Set([
  'https://api.moonshot.ai/v1',
  'https://api.moonshot.cn/v1',
])

export function isAllowedKimiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ALLOWED_KIMI_BASE_URLS.has(url.href.replace(/\/$/, ''))
  } catch {
    return false
  }
}

const LLMConfigSchema = z.object({
  provider: z.enum(LLM_PROVIDERS).default('ollama'),

  // Ollama
  ollamaBaseUrl: z.string().default('http://localhost:11434'),
  ollamaQuickModel: z.string().default(DEFAULT_PROVIDER_MODELS.ollama.quick),
  ollamaDeepModel: z.string().default(DEFAULT_PROVIDER_MODELS.ollama.deep),
  ollamaQuickMaxTokens: z.coerce.number().default(4096),
  ollamaDeepMaxTokens: z.coerce.number().default(8192),
  // Context window (num_ctx). Must fit system prompt + architecture + RAG
  // output or Ollama silently truncates. Lower these if VRAM is tight.
  ollamaQuickNumCtx: z.coerce.number().int().min(2048).default(16384),
  ollamaDeepNumCtx: z.coerce.number().int().min(4096).default(32768),

  // Google Gemini
  googleApiKey: z.string().optional(),
  geminiQuickModel: z.string().default(DEFAULT_PROVIDER_MODELS.google.quick),
  geminiDeepModel: z.string().default(DEFAULT_PROVIDER_MODELS.google.deep),
  geminiQuickMaxTokens: z.coerce.number().default(8192),
  geminiDeepMaxTokens: z.coerce.number().default(16384),

  // Kimi / Moonshot (OpenAI-compatible)
  kimiApiKey: z.string().optional(),
  // Deliberately NOT validated with .refine() here: an env var scoped to a
  // provider the deployment doesn't even use (e.g. a stray KIMI_BASE_URL on a
  // Bedrock-only deployment) must not crash config loading for every request.
  // The allowlist is enforced at actual use time instead — see
  // `lib/llm/factory.ts` (makeKimiModel) and `lib/llm/check-key.ts` (checkKimi).
  kimiBaseUrl: z.string().default('https://api.moonshot.ai/v1'),
  kimiQuickModel: z.string().default(DEFAULT_PROVIDER_MODELS.kimi.quick),
  kimiDeepModel: z.string().default(DEFAULT_PROVIDER_MODELS.kimi.deep),
  kimiQuickMaxTokens: z.coerce.number().default(8192),
  kimiDeepMaxTokens: z.coerce.number().default(16384),

  // AWS Bedrock (Converse API)
  bedrockRegion: z.string().default('us-east-1'),
  bedrockAccessKeyId: z.string().optional(),
  bedrockSecretAccessKey: z.string().optional(),
  bedrockSessionToken: z.string().optional(),
  /** Optional Application Inference Profile ARN */
  bedrockInferenceProfile: z.string().optional(),
  bedrockQuickModel: z.string().default(DEFAULT_PROVIDER_MODELS.bedrock.quick),
  bedrockDeepModel: z.string().default(DEFAULT_PROVIDER_MODELS.bedrock.deep),
  bedrockQuickMaxTokens: z.coerce.number().default(8192),
  bedrockDeepMaxTokens: z.coerce.number().default(16384),

  // Cursor SDK (Grok 4.7 by default) — agent runtime used as a text-only ChatModel
  cursorApiKey: z.string().optional(),
  cursorQuickModel: z.string().default(DEFAULT_PROVIDER_MODELS.cursor.quick),
  cursorDeepModel: z.string().default(DEFAULT_PROVIDER_MODELS.cursor.deep),
  cursorQuickFast: EnvBooleanSchema.default(true),
})

const RAGConfigSchema = z.object({
  chromaHost: z.string().default('localhost'),
  chromaPort: z.coerce.number().default(8000),
  topK: z.coerce.number().default(5),
  confidenceThreshold: z.coerce.number().default(0.65),
  embeddingProvider: z.enum(['ollama', 'google']).default('ollama'),
  embeddingModel: z.string().default('qwen3-embedding:4b'),
  knowledgeBasePath: z.string().default('./knowledge_base'),
  pageIndicesPath: z.string().default('./data/page_indices'),
})

const PipelineConfigSchema = z.object({
  executionMode: z.enum(['hybrid', 'parallel', 'cascade']).default('hybrid'),
  maxParallelAnalysts: z.coerce.number().default(2),
  maxDebateRounds: z.coerce.number().default(3),
  enabledAnalysts: z
    .string()
    .default('stride,pasta,attack_tree')
    .transform((v) => v.split(',') as ('stride' | 'pasta' | 'attack_tree')[]),
  minThreats: z.coerce.number().default(8),
  targetThreats: z.coerce.number().default(15),
  maxThreats: z.coerce.number().default(30),
  requireEvidenceForHighPriority: EnvBooleanSchema.default(true),
  // Single confidence gate for raw threats, applied once in pre-dedup.
  threatConfidenceThreshold: z.coerce.number().min(0).max(1).default(0.55),
  // Max concurrent LLM batch calls in the DREAD validator / synthesizer.
  // TODO(v2-fase5): expose in Settings UI; env var until then.
  validatorConcurrency: z.coerce.number().int().min(1).max(8).default(3),
})

const AppConfigSchema = z.object({
  // Optional in local workspace mode: analyses persist to the selected
  // project's SQLite database instead of a shared PostgreSQL server.
  databaseUrl: z.string().min(1).optional(),
  partnerBaseUrl: z.string().optional(),
  llm: LLMConfigSchema,
  rag: RAGConfigSchema,
  pipeline: PipelineConfigSchema,
})

function loadConfig() {
  return AppConfigSchema.parse({
    databaseUrl: process.env.DATABASE_URL || undefined,
    partnerBaseUrl: process.env.PARTNER_BASE_URL,
    llm: {
      provider: process.env.LLM_PROVIDER,
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
      ollamaQuickModel: process.env.OLLAMA_QUICK_MODEL ?? process.env.OLLAMA_MODEL,
      ollamaDeepModel: process.env.OLLAMA_DEEP_MODEL ?? process.env.OLLAMA_MODEL,
      ollamaQuickMaxTokens: process.env.OLLAMA_QUICK_MAX_TOKENS,
      ollamaDeepMaxTokens: process.env.OLLAMA_DEEP_MAX_TOKENS,
      ollamaQuickNumCtx: process.env.OLLAMA_QUICK_NUM_CTX,
      ollamaDeepNumCtx: process.env.OLLAMA_DEEP_NUM_CTX,

      googleApiKey: process.env.GOOGLE_API_KEY,
      geminiQuickModel: process.env.GEMINI_QUICK_MODEL,
      geminiDeepModel: process.env.GEMINI_DEEP_MODEL,
      geminiQuickMaxTokens: process.env.GEMINI_QUICK_MAX_TOKENS,
      geminiDeepMaxTokens: process.env.GEMINI_DEEP_MAX_TOKENS,

      // Accept either MOONSHOT_API_KEY (official) or KIMI_API_KEY
      kimiApiKey: process.env.MOONSHOT_API_KEY ?? process.env.KIMI_API_KEY,
      kimiBaseUrl: process.env.KIMI_BASE_URL ?? process.env.MOONSHOT_BASE_URL,
      kimiQuickModel: process.env.KIMI_QUICK_MODEL,
      kimiDeepModel: process.env.KIMI_DEEP_MODEL,
      kimiQuickMaxTokens: process.env.KIMI_QUICK_MAX_TOKENS,
      kimiDeepMaxTokens: process.env.KIMI_DEEP_MAX_TOKENS,

      bedrockRegion: process.env.BEDROCK_AWS_REGION ?? process.env.AWS_REGION,
      bedrockAccessKeyId:
        process.env.BEDROCK_AWS_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID,
      bedrockSecretAccessKey:
        process.env.BEDROCK_AWS_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY,
      bedrockSessionToken:
        process.env.BEDROCK_AWS_SESSION_TOKEN ?? process.env.AWS_SESSION_TOKEN,
      bedrockInferenceProfile: process.env.BEDROCK_INFERENCE_PROFILE_ARN,
      bedrockQuickModel: process.env.BEDROCK_QUICK_MODEL,
      bedrockDeepModel: process.env.BEDROCK_DEEP_MODEL,
      bedrockQuickMaxTokens: process.env.BEDROCK_QUICK_MAX_TOKENS,
      bedrockDeepMaxTokens: process.env.BEDROCK_DEEP_MAX_TOKENS,

      cursorApiKey: process.env.CURSOR_API_KEY,
      cursorQuickModel: process.env.CURSOR_QUICK_MODEL,
      cursorDeepModel: process.env.CURSOR_DEEP_MODEL,
      cursorQuickFast: process.env.CURSOR_QUICK_FAST,
    },
    rag: {
      chromaHost: process.env.CHROMA_HOST,
      chromaPort: process.env.CHROMA_PORT,
      topK: process.env.RAG_TOP_K,
      confidenceThreshold: process.env.RAG_CONFIDENCE_THRESHOLD,
      embeddingProvider: process.env.EMBEDDING_PROVIDER,
      embeddingModel: process.env.EMBEDDING_MODEL,
      knowledgeBasePath: process.env.KNOWLEDGE_BASE_PATH,
      pageIndicesPath: process.env.PAGE_INDICES_PATH,
    },
    pipeline: {
      executionMode: process.env.PIPELINE_EXECUTION_MODE,
      maxParallelAnalysts: process.env.PIPELINE_MAX_PARALLEL_ANALYSTS,
      maxDebateRounds: process.env.PIPELINE_MAX_DEBATE_ROUNDS,
      requireEvidenceForHighPriority: process.env.PIPELINE_REQUIRE_EVIDENCE_FOR_HIGH_PRIORITY,
      targetThreats: process.env.PIPELINE_TARGET_THREATS,
      threatConfidenceThreshold: process.env.PIPELINE_CONFIDENCE_THRESHOLD,
      validatorConcurrency: process.env.PIPELINE_VALIDATOR_CONCURRENCY,
    },
  })
}

export type AppConfig = z.infer<typeof AppConfigSchema>

let _config: AppConfig | null = null

export function getConfig(): AppConfig {
  if (!_config) _config = loadConfig()
  return _config
}

/**
 * Eager env validation, called once at server boot (instrumentation.ts).
 * Throws a readable error listing every invalid setting instead of letting
 * the first request blow up on a lazily-parsed config. DATABASE_URL stays
 * optional by design (local workspace mode).
 */
export function validateConfig(): AppConfig {
  try {
    if (!_config) _config = loadConfig()
    return _config
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')
      throw new Error(
        `Invalid environment configuration — fix these settings and restart:\n${issues}`,
      )
    }
    throw err
  }
}

/** Reset cached config (tests / hot-reload of env). */
export function clearConfigCache(): void {
  _config = null
}

export function getOllamaModelForRole(role: LLMRole, config: AppConfig): string {
  return role === 'deep' || role === 'stride'
    ? config.llm.ollamaDeepModel
    : config.llm.ollamaQuickModel
}

/**
 * Resolve quick/deep model name for the active (or requested) provider.
 */
export function getModelForProviderRole(
  provider: LLMProvider,
  role: LLMRole,
  config: AppConfig
): string {
  const deep = role === 'deep' || role === 'stride'
  switch (provider) {
    case 'google':
      return deep ? config.llm.geminiDeepModel : config.llm.geminiQuickModel
    case 'kimi':
      return deep ? config.llm.kimiDeepModel : config.llm.kimiQuickModel
    case 'bedrock':
      return deep ? config.llm.bedrockDeepModel : config.llm.bedrockQuickModel
    case 'cursor':
      return deep ? config.llm.cursorDeepModel : config.llm.cursorQuickModel
    case 'ollama':
    default:
      return deep ? config.llm.ollamaDeepModel : config.llm.ollamaQuickModel
  }
}

export function providerHasCredentials(provider: LLMProvider, config: AppConfig): boolean {
  switch (provider) {
    case 'ollama':
      return true
    case 'google':
      return Boolean(config.llm.googleApiKey)
    case 'kimi':
      return Boolean(config.llm.kimiApiKey)
    case 'bedrock':
      // A region plus the default AWS credential chain is valid, but not verified
      // until the explicit Check Key call succeeds.
      return Boolean(config.llm.bedrockRegion) &&
        Boolean(config.llm.bedrockAccessKeyId) === Boolean(config.llm.bedrockSecretAccessKey)
    case 'cursor':
      return Boolean(config.llm.cursorApiKey)
    default:
      return false
  }
}
