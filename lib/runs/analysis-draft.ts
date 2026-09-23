import type { AnalysisConfig } from '@/lib/models/types'

export const ANALYSIS_DRAFT_STORAGE_KEY = 'agentictm:analysis-draft:v1'

export type AnalysisDraft = {
  schemaVersion: 1
  systemName: string
  systemId?: string
  input: string
  inputType: 'text' | 'file'
  config: Partial<AnalysisConfig>
  selectedPreviousRun: string
  sourceRunId?: string
}

const PROVIDERS = new Set<AnalysisConfig['provider']>([
  'ollama',
  'google',
  'kimi',
  'bedrock',
  'cursor',
])
const PROFILES = new Set<NonNullable<AnalysisConfig['executionProfile']>>([
  'local_efficient',
  'provider_optimized',
  'provider_full_power',
  'adaptive_value',
])
const ANALYSTS = new Set<AnalysisConfig['enabledAnalysts'][number]>([
  'stride',
  'pasta',
  'attack_tree',
])
const EXECUTION_MODES = new Set<AnalysisConfig['executionMode']>([
  'hybrid',
  'parallel',
  'cascade',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseConfig(value: unknown): Partial<AnalysisConfig> {
  if (!isRecord(value)) return {}

  const config: Partial<AnalysisConfig> = {}
  if (PROVIDERS.has(value.provider as AnalysisConfig['provider'])) {
    config.provider = value.provider as AnalysisConfig['provider']
  }
  if (Array.isArray(value.allowedProviders)) {
    config.allowedProviders = value.allowedProviders.filter(
      (provider): provider is AnalysisConfig['provider'] => PROVIDERS.has(provider as AnalysisConfig['provider']),
    )
  }
  if (PROFILES.has(value.executionProfile as NonNullable<AnalysisConfig['executionProfile']>)) {
    config.executionProfile = value.executionProfile as NonNullable<AnalysisConfig['executionProfile']>
  }
  if (Array.isArray(value.allowedProfiles)) {
    config.allowedProfiles = value.allowedProfiles.filter(
      (profile): profile is NonNullable<AnalysisConfig['executionProfile']> =>
        PROFILES.has(profile as NonNullable<AnalysisConfig['executionProfile']>),
    )
  }
  if (typeof value.quickModel === 'string') config.quickModel = value.quickModel
  if (typeof value.deepModel === 'string') config.deepModel = value.deepModel
  if (Array.isArray(value.enabledAnalysts)) {
    config.enabledAnalysts = value.enabledAnalysts.filter(
      (analyst): analyst is AnalysisConfig['enabledAnalysts'][number] =>
        ANALYSTS.has(analyst as AnalysisConfig['enabledAnalysts'][number]),
    )
  }
  if (EXECUTION_MODES.has(value.executionMode as AnalysisConfig['executionMode'])) {
    config.executionMode = value.executionMode as AnalysisConfig['executionMode']
  }
  if (typeof value.maxDebateRounds === 'number' && Number.isFinite(value.maxDebateRounds)) {
    config.maxDebateRounds = value.maxDebateRounds
  }
  if (typeof value.targetThreats === 'number' && Number.isFinite(value.targetThreats)) {
    config.targetThreats = value.targetThreats
  }
  if (typeof value.requireEvidenceForHighPriority === 'boolean') {
    config.requireEvidenceForHighPriority = value.requireEvidenceForHighPriority
  }
  if (typeof value.useRag === 'boolean') {
    config.useRag = value.useRag
  }
  return config
}

export function parseAnalysisDraft(raw: string | null): AnalysisDraft | null {
  if (!raw) return null

  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.schemaVersion !== 1) return null
    if (typeof value.systemName !== 'string' || typeof value.input !== 'string') return null
    if (value.inputType !== 'text' && value.inputType !== 'file') return null
    if (typeof value.selectedPreviousRun !== 'string') return null
    if (value.systemId !== undefined && typeof value.systemId !== 'string') return null
    if (value.sourceRunId !== undefined && typeof value.sourceRunId !== 'string') return null

    return {
      schemaVersion: 1,
      systemName: value.systemName,
      ...(typeof value.systemId === 'string' ? { systemId: value.systemId } : {}),
      input: value.input,
      inputType: value.inputType,
      config: parseConfig(value.config),
      selectedPreviousRun: value.selectedPreviousRun,
      ...(typeof value.sourceRunId === 'string' ? { sourceRunId: value.sourceRunId } : {}),
    }
  } catch {
    return null
  }
}
