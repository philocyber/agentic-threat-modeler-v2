import { isProviderBillingError, ProviderBillingError } from './provider-errors'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Token accounting for one pipeline run.
 *
 * Providers report token counts on every response but never report price, so
 * tokens are exact and cost is an estimate derived from a local rate table.
 * A model with no configured rate reports tokens and no cost: an invented price
 * is worse than no price.
 */
export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  calls: number
}

/** Per-agent quality events, for "which stage is degrading" questions. */
export type AgentEvents = {
  bestEffortParses: number
  validationRetries: number
  transportRetries: number
}

export type UsageTotals = {
  inputTokens: number
  outputTokens: number
  calls: number
  byModel: Record<string, ModelUsage>
  modelProviders: Record<string, string>
  byProviderModelAgent: Record<string, ModelUsage>
  /** Token attribution per pipeline agent (StrideAnalyst, DreadValidator, …). */
  byAgent: Record<string, ModelUsage>
  agentEvents: Record<string, AgentEvents>
}

const usageStorage = new AsyncLocalStorage<UsageTotals>()
const billingFailures = new WeakMap<UsageTotals, ProviderBillingError>()

/** Block subsequent model calls only in the run that encountered the failure. */
export function recordProviderFailure(error: unknown): ProviderBillingError | null {
  if (!isProviderBillingError(error)) return null
  const failure = new ProviderBillingError()
  const usage = currentUsage()
  if (usage) billingFailures.set(usage, failure)
  return failure
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    byModel: {},
    modelProviders: {},
    byProviderModelAgent: {},
    byAgent: {},
    agentEvents: {},
  }
}

export function emptyAgentEvents(): AgentEvents {
  return { bestEffortParses: 0, validationRetries: 0, transportRetries: 0 }
}

/**
 * Count a degradation event for one agent. Retries and best-effort parses are
 * the signal that a prompt or a schema stopped fitting the model — a run can be
 * "successful" and still be limping.
 */
export function recordAgentEvent(agent: string, kind: keyof AgentEvents): void {
  const usage = usageStorage.getStore()
  if (!usage) return
  const events = usage.agentEvents[agent] ?? emptyAgentEvents()
  events[kind] += 1
  usage.agentEvents[agent] = events
}

/**
 * Runs `fn` with every nested LLM call reporting into `usage`. The caller owns
 * the accumulator so it can be read while the run is still in flight — which is
 * what lets a run that dies mid-pipeline still report what it burned.
 */
export function runWithUsage<T>(usage: UsageTotals, fn: () => Promise<T>): Promise<T> {
  return usageStorage.run(usage, fn)
}

export function totalTokens(usage: UsageTotals): number {
  return usage.inputTokens + usage.outputTokens
}

export function currentUsage(): UsageTotals | null {
  return usageStorage.getStore() ?? null
}

type UsageMetadata = { input_tokens?: number; output_tokens?: number }

/**
 * Reads LangChain's normalized `usage_metadata`, which every provider adapter
 * populates from its own response shape.
 */
export function recordUsage(
  message: unknown,
  model: string | null,
  agent?: string,
  provider = 'unknown',
): void {
  const usage = usageStorage.getStore()
  if (!usage) return

  const metadata = (message as { usage_metadata?: UsageMetadata } | null)?.usage_metadata
  if (!metadata) return

  const validTokens = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  const input = validTokens(metadata.input_tokens)
  const output = validTokens(metadata.output_tokens)
  if (input === 0 && output === 0) return

  usage.inputTokens += input
  usage.outputTokens += output
  usage.calls += 1

  const key = model ?? 'unknown'
  const perModel = usage.byModel[key] ?? { inputTokens: 0, outputTokens: 0, calls: 0 }
  perModel.inputTokens += input
  perModel.outputTokens += output
  perModel.calls += 1
  usage.byModel[key] = perModel
  usage.modelProviders[key] = provider

  const tupleKey = `${provider}:${key}:${agent ?? 'unknown'}`
  const tuple = usage.byProviderModelAgent[tupleKey] ?? { inputTokens: 0, outputTokens: 0, calls: 0 }
  tuple.inputTokens += input
  tuple.outputTokens += output
  tuple.calls += 1
  usage.byProviderModelAgent[tupleKey] = tuple

  if (agent) {
    const perAgent = usage.byAgent[agent] ?? { inputTokens: 0, outputTokens: 0, calls: 0 }
    perAgent.inputTokens += input
    perAgent.outputTokens += output
    perAgent.calls += 1
    usage.byAgent[agent] = perAgent
  }
}

/** Best-effort model name off a LangChain chat model, for per-model attribution. */
export function modelNameOf(llm: unknown): string | null {
  const candidate = llm as { model?: unknown; modelName?: unknown } | null
  const name = candidate?.model ?? candidate?.modelName
  return typeof name === 'string' && name.length > 0 ? name : null
}

export function providerNameOf(llm: unknown): string {
  const candidate = llm as { providerName?: unknown; _llmType?: () => string } | null
  if (typeof candidate?.providerName === 'string') return candidate.providerName
  const type = candidate?._llmType?.() ?? ''
  if (type.includes('ollama')) return 'ollama'
  if (type.includes('google')) return 'google'
  if (type.includes('bedrock')) return 'bedrock'
  if (type.includes('cursor')) return 'cursor'
  if (type.includes('openai')) return 'kimi'
  return 'unknown'
}

export type ModelRate = { input: number; output: number }

/**
 * USD per 1M tokens, keyed by model name. Local models are free; everything else
 * has to be supplied through LLM_PRICES_JSON, e.g.
 * `{"kimi-k2.6":{"input":0.95,"output":4}}`. Rates are deliberately not
 * hardcoded: they change per provider and go stale silently, and a wrong number
 * here is a wrong number in front of the user.
 */
export function configuredRates(): Record<string, ModelRate> {
  const raw = process.env.LLM_PRICES_JSON
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ModelRate] => {
      const rate: unknown = entry[1]
      if (!rate || typeof rate !== 'object') return false
      const { input, output } = rate as Partial<ModelRate>
      return typeof input === 'number' && Number.isFinite(input) && input >= 0
        && typeof output === 'number' && Number.isFinite(output) && output >= 0
    }))
  } catch {
    return {}
  }
}

export type CostEstimate = {
  totalUsd: number
  pricedModels: string[]
  unpricedModels: string[]
}

/**
 * Returns the estimate plus the models it could not price, so the UI can show
 * "estimated from 2 of 3 models" instead of implying a complete figure.
 */
export function estimateCost(usage: UsageTotals): CostEstimate {
  const rates = configuredRates()
  let totalUsd = 0
  const pricedModels: string[] = []
  const unpricedModels: string[] = []

  for (const [model, perModel] of Object.entries(usage.byModel)) {
    if (usage.modelProviders[model] === 'ollama') {
      pricedModels.push(model)
      continue
    }
    const rate = rates[model]
    if (!rate) {
      unpricedModels.push(model)
      continue
    }
    totalUsd += (perModel.inputTokens / 1_000_000) * rate.input
    totalUsd += (perModel.outputTokens / 1_000_000) * rate.output
    pricedModels.push(model)
  }

  return { totalUsd, pricedModels, unpricedModels }
}

export class RunCostLimitError extends Error {
  readonly code = 'PIPELINE_COST_LIMIT'
  constructor(limit: number) {
    super(`Run cost limit of $${limit.toFixed(4)} was reached`)
    this.name = 'RunCostLimitError'
  }
}

export function assertRunCostBudget(): void {
  const activeUsage = currentUsage()
  const failure = activeUsage && billingFailures.get(activeUsage)
  if (failure) throw failure
  const max = Number(process.env.MAX_RUN_COST_USD)
  if (!Number.isFinite(max) || max <= 0) return
  const usage = currentUsage()
  if (usage && estimateCost(usage).totalUsd >= max) throw new RunCostLimitError(max)
}

export function unpricedSelectedCloudModels(provider: string, models: string[]): string[] {
  const max = Number(process.env.MAX_RUN_COST_USD)
  if (!Number.isFinite(max) || max <= 0 || provider === 'ollama') return []
  const rates = configuredRates()
  return [...new Set(models)].filter((model) => !rates[model])
}
