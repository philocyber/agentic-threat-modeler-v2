import { CONTEXT_CATALOG_VERSION } from '@/lib/llm/context-capacity'
import {
  ADAPTER_CONTRACT_VERSION,
  ANALYSIS_RULES_VERSION,
  EVIDENCE_CONTRACT_VERSION,
  PIPELINE_WORKER_CODE_VERSION,
} from '@/lib/contracts/versions'
import { createHash } from 'node:crypto'
import type { AnalysisConfig } from '@/lib/db/schema'
import { getModelForProviderRole, type AppConfig } from '@/lib/config'

/** Only the selected provider's resolved settings affect checkpoint compatibility. */
export function manifestModelSettings(app: AppConfig, config: AnalysisConfig) {
  const llm = app.llm
  const provider = config.provider ?? llm.provider
  const output = provider === 'ollama' ? [llm.ollamaQuickMaxTokens, llm.ollamaDeepMaxTokens]
    : provider === 'google' ? [llm.geminiQuickMaxTokens, llm.geminiDeepMaxTokens]
    : provider === 'kimi' ? [llm.kimiQuickMaxTokens, llm.kimiDeepMaxTokens]
    : provider === 'bedrock' ? [llm.bedrockQuickMaxTokens, llm.bedrockDeepMaxTokens] : null
  return {
    quick: config.quickModel ?? getModelForProviderRole(provider, 'quick', app),
    deep: config.deepModel ?? getModelForProviderRole(provider, 'deep', app),
    output,
    ...(provider === 'ollama' ? { context: [llm.ollamaQuickNumCtx, llm.ollamaDeepNumCtx] } : {}),
    ...(provider === 'cursor' ? { quickFast: llm.cursorQuickFast } : {}),
  }
}

export const RUN_MANIFEST_VERSION = 2 as const
export const PROMPT_SET_VERSION = 'agentic-tm-prompts-2026-09-16-reference-provenance-v14'

export type RunManifestCategory =
  | 'input'
  | 'system'
  | 'configuration'
  | 'models'
  | 'analysts'
  | 'rag_index'
  | 'prompts'

export type RunManifestV2 = {
  version: typeof RUN_MANIFEST_VERSION
  fingerprint: string
  categories: Record<RunManifestCategory, string>
}

const MANIFEST_CATEGORIES: RunManifestCategory[] = [
  'input', 'system', 'configuration', 'models', 'analysts', 'rag_index', 'prompts',
]

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    )
  }
  return value
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}

export function createRunManifest(input: {
  inputFingerprint: string
  systemId: string
  config: AnalysisConfig
  ragIndexFingerprint: string
  modelSettings?: ReturnType<typeof manifestModelSettings>
}): RunManifestV2 {
  const { config } = input
  const categories: RunManifestV2['categories'] = {
    input: digest(input.inputFingerprint),
    system: digest(input.systemId),
    configuration: digest({
      contextCatalog: CONTEXT_CATALOG_VERSION,
      contextWindows: process.env.MODEL_CONTEXT_WINDOWS ?? '{}',
      ollamaQuickContext: process.env.OLLAMA_QUICK_NUM_CTX ?? '16384',
      ollamaDeepContext: process.env.OLLAMA_DEEP_NUM_CTX ?? '32768',
      executionMode: config.executionMode,
      maxDebateRounds: config.maxDebateRounds,
      targetThreats: config.targetThreats,
      requireEvidenceForHighPriority: config.requireEvidenceForHighPriority,
      useRag: config.useRag !== false,
      executionProfile: config.executionProfile,
      allowedProfiles: config.allowedProfiles,
      allowedProviders: config.allowedProviders,
      evidenceContract: EVIDENCE_CONTRACT_VERSION,
      adapterContract: ADAPTER_CONTRACT_VERSION,
      analysisRules: ANALYSIS_RULES_VERSION,
      workerCode: PIPELINE_WORKER_CODE_VERSION,
    }),
    models: digest({ provider: config.provider, quick: config.quickModel, deep: config.deepModel, resolved: input.modelSettings }),
    analysts: digest([...config.enabledAnalysts].sort()),
    rag_index: digest(input.ragIndexFingerprint),
    prompts: digest(PROMPT_SET_VERSION),
  }
  return { version: RUN_MANIFEST_VERSION, fingerprint: digest(categories), categories }
}

export function isRunManifestV2(value: unknown): value is RunManifestV2 {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RunManifestV2>
  if (candidate.version !== RUN_MANIFEST_VERSION
    || typeof candidate.fingerprint !== 'string'
    || !candidate.categories) return false
  if (!MANIFEST_CATEGORIES.every((category) => /^[a-f0-9]{64}$/.test(candidate.categories?.[category] ?? ''))) {
    return false
  }
  return candidate.fingerprint === digest(candidate.categories)
}

export function incompatibleManifestCategories(
  previous: RunManifestV2,
  current: RunManifestV2,
): RunManifestCategory[] {
  return (Object.keys(current.categories) as RunManifestCategory[])
    .filter((category) => previous.categories[category] !== current.categories[category])
}
