import { configuredRates, currentUsage, estimateCost, RunCostLimitError, type UsageTotals } from './usage'

export class UnpricedModelError extends Error {
  readonly code = 'UNPRICED_MODEL'
  constructor(model: string) {
    super(`No verified rate is configured for ${model}. Paid calls are blocked until LLM_PRICES_JSON includes this model.`)
    this.name = 'UnpricedModelError'
  }
}

const reservations = new WeakMap<UsageTotals, number>()

function reservedUsd(usage: UsageTotals | null): number {
  return usage ? reservations.get(usage) ?? 0 : 0
}

export function estimateCallUsd(params: {
  provider: string
  model: string
  maxInputTokens: number
  maxOutputTokens: number
}): number {
  if (params.provider === 'ollama') return 0
  const rate = configuredRates()[params.model]
  if (!rate) {
    const max = Number(process.env.MAX_RUN_COST_USD)
    if (Number.isFinite(max) && max > 0) throw new UnpricedModelError(params.model)
    return 0
  }
  return (params.maxInputTokens / 1_000_000) * rate.input + (params.maxOutputTokens / 1_000_000) * rate.output
}

/** Hold budget including max output. Unknown consumption keeps the hold. */
export function reserveRunCost(params: {
  provider: string
  model: string
  maxInputTokens: number
  maxOutputTokens: number
}): number {
  const usage = currentUsage()
  const usd = estimateCallUsd(params)
  if (!usage || usd <= 0) return usd
  const next = reservedUsd(usage) + usd
  const max = Number(process.env.MAX_RUN_COST_USD)
  if (Number.isFinite(max) && max > 0 && estimateCost(usage).totalUsd + next > max) {
    throw new RunCostLimitError(max)
  }
  reservations.set(usage, next)
  return usd
}

/** Release only after complete provider usage has been recorded in UsageTotals. */
export function settleRunCostReservation(heldUsd: number): void {
  const usage = currentUsage()
  if (!usage || heldUsd <= 0) return
  const current = reservedUsd(usage)
  reservations.set(usage, Math.max(0, current - heldUsd))
}

export function heldReservationUsd(usage: UsageTotals | null = currentUsage()): number {
  return reservedUsd(usage)
}
