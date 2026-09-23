/** Safe, provider-independent failure classification. Never expose SDK account details. */
export class ProviderBillingError extends Error {
  readonly code = 'PROVIDER_BILLING_BLOCKED'
  constructor() {
    super('Model provider balance or billing quota is exhausted. Restore provider billing before resuming this analysis.')
    this.name = 'ProviderBillingError'
  }
}

export function isProviderBillingError(error: unknown): boolean {
  const seen = new Set<unknown>()
  function inspect(value: unknown, depth: number): boolean {
    if (depth > 5 || value == null || seen.has(value)) return false
    seen.add(value)
    if (typeof value === 'string') {
      return /PROVIDER_BILLING_BLOCKED|provider balance or billing quota is exhausted|provider billing exhausted|insufficient[_ ](?:balance|quota)|please recharge|billing[_ ]hard[_ ]limit|(?:credits?|balance) (?:is |are )?exhausted/i.test(value)
    }
    if (typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    return ['code', 'message', 'type', 'cause', 'error'].some((key) => inspect(record[key], depth + 1))
  }
  return inspect(error, 0)
}

/** Compatibility for historical telemetry whose public error lost the billing cause. */
export function telemetryHasBillingFailure(jsonl: string): boolean {
  return jsonl.split('\n').some((line) => {
    try { return isProviderBillingError(JSON.parse(line)) } catch { return false }
  })
}
