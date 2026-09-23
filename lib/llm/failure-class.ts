import { isProviderBillingError } from '@/lib/llm/provider-errors'

/** Operator-facing failure classes. Retry policy is derived from these. */
export type FailureClass =
  | 'reference'
  | 'invalid_json'
  | 'truncation'
  | 'insufficient_context'
  | 'transport'
  | 'authentication'
  | 'billing'
  | 'validation'
  | 'timeout'
  | 'rate_limit'
  | 'server'
  | 'invalid_params'
  | 'cancelled'
  | 'unknown'

const REFERENCE_HINT =
  /quotation|citation|passage|SRC-\d+|RAG-[a-f0-9]|original SRC|sourceName|evidenceSources/i

type StructuredIssue = { path: PropertyKey[]; message: string }

function structuredIssues(error: unknown): StructuredIssue[] {
  if (!error || typeof error !== 'object') return []
  const issues = (error as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return []
  return issues.filter((issue): issue is StructuredIssue => (
    Boolean(issue && typeof issue === 'object' && Array.isArray((issue as { path?: unknown }).path))
  )).map((issue) => ({
    path: issue.path,
    message: typeof issue.message === 'string' ? issue.message : '',
  }))
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' ? String((error as { name?: unknown }).name ?? '') : ''
}

export function rejectedFieldsOf(error: unknown): string[] {
  if (errorName(error) !== 'StructuredOutputError') return []
  return [...new Set(structuredIssues(error).map((issue) => issue.path.join('.') || '(root)'))]
}

export function classifyFailure(error: unknown): FailureClass {
  if (error == null) return 'unknown'
  if (isProviderBillingError(error)) return 'billing'
  if (errorName(error) === 'StructuredOutputTruncatedError') return 'truncation'
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return error.name === 'AbortError' ? 'cancelled' : 'timeout'
  }
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (code === 'SOURCE_COVERAGE_INCOMPLETE' || code === 'MODEL_CONTEXT_OVERFLOW' || code === 'OLLAMA_CONTEXT_OVERFLOW') {
      return 'insufficient_context'
    }
    if (code === 'PIPELINE_CANCELLED') return 'cancelled'
    if (code === 'PROVIDER_BILLING_BLOCKED' || code === 'PIPELINE_COST_LIMIT') return 'billing'
    if (code === 'UNPRICED_MODEL' || code === 'MODEL_CALL_LIMIT') return 'invalid_params'
    if ((error as { name?: unknown }).name === 'MandatoryAnalystError') {
      return classifyFailure((error as { cause?: unknown }).cause ?? error)
    }
  }
  if (errorName(error) === 'StructuredOutputError') {
    const issues = structuredIssues(error)
    if (issues.length === 0) return 'invalid_json'
    if (issues.some((issue) => REFERENCE_HINT.test(`${issue.path.join('.')} ${issue.message}`))) {
      return 'reference'
    }
    return 'validation'
  }

  const status = extractHttpStatus(error)
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
  const names = collectNames(error)
  if (/throttlingexception|toomanyrequestsexception/.test(names) || /throttl(?:ed|ing)/.test(msg) || status === 429) {
    return 'rate_limit'
  }
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid api key|invalid_api_key/.test(msg)) {
    return 'authentication'
  }
  if (status === 400 || /invalid[_ ](?:parameter|request|argument)|unknown model/.test(msg)) {
    return 'invalid_params'
  }
  if (status !== undefined && status >= 500) return 'server'
  if (status !== undefined && status >= 400) return 'invalid_params'
  if (/fetch failed|econnreset|econnrefused|enotfound|etimedout|eai_again|socket hang up|network error|did not receive done/.test(msg)) {
    return 'transport'
  }
  if (/account .* suspended/.test(msg)) return 'authentication'
  return 'unknown'
}

export function isRetryableFailure(failureClass: FailureClass): boolean {
  return failureClass === 'validation'
    || failureClass === 'reference'
    || failureClass === 'invalid_json'
    || failureClass === 'truncation'
    || failureClass === 'timeout'
    || failureClass === 'rate_limit'
    || failureClass === 'server'
    || failureClass === 'transport'
}

export function publicFailureMessage(error: unknown, fallback = 'Analysis failed'): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'MODEL_CALL_LIMIT') return 'The configured model call limit was reached. No further request was sent.'
  if (code === 'PIPELINE_COST_LIMIT') return 'The configured run spending limit was reached. Review the budget before resuming.'
  if (code === 'UNPRICED_MODEL') return 'A verified model rate is required before this budgeted run can send paid requests.'
  const failureClass = classifyFailure(error)
  if (failureClass === 'reference') {
    return 'The output failed reference validation: a citation could not be resolved or linked to the named component. Inspect the rejected fields in the attempt diagnostics. This is a reference failure, not a context-size problem.'
  }
  if (failureClass === 'invalid_json') {
    return 'The model returned output that was not valid JSON for the required schema.'
  }
  if (failureClass === 'truncation') {
    return 'The model hit its output token limit and the response was cut mid-structure.'
  }
  if (failureClass === 'insufficient_context') {
    return 'Original source coverage or model context is insufficient. Inspect source coverage and configure the model context before retrying.'
  }
  if (failureClass === 'authentication') {
    return 'Model provider authentication failed. Restore valid credentials before resuming.'
  }
  if (failureClass === 'billing') {
    return 'Model provider balance or billing quota is exhausted. Restore provider billing before resuming this analysis.'
  }
  if (failureClass === 'transport') {
    return 'The model provider transport failed. Retry after the provider is reachable.'
  }
  if (failureClass === 'timeout') return 'The model call timed out'
  if (failureClass === 'cancelled') return 'Stopped by user'
  if (failureClass === 'rate_limit') return 'The model provider rate-limited the request.'
  if (failureClass === 'invalid_params') return 'The model request used invalid parameters and was not sent again.'
  if (failureClass === 'validation') return 'The model response did not satisfy the required schema.'
  return fallback
}

function extractHttpStatus(err: unknown): number | undefined {
  const seen: unknown[] = [err, (err as { cause?: unknown } | null)?.cause]
  for (const candidate of seen) {
    if (!candidate || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    const metadata = record.$metadata
    if (metadata && typeof metadata === 'object') {
      const status = (metadata as Record<string, unknown>).httpStatusCode
      if (typeof status === 'number') return status
    }
    for (const key of ['status', 'statusCode'] as const) {
      const value = record[key]
      if (typeof value === 'number' && value >= 100 && value < 600) return value
    }
  }
  return undefined
}

function collectNames(err: unknown): string {
  return [err, (err as { cause?: unknown } | null)?.cause]
    .flatMap((value) => value && typeof value === 'object'
      ? [String((value as { name?: unknown }).name ?? ''), String((value as { code?: unknown }).code ?? '')]
      : [])
    .join(' ')
    .toLowerCase()
}
