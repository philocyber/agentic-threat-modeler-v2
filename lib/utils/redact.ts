import { isProviderBillingError, ProviderBillingError } from '@/lib/llm/provider-errors'
import { classifyFailure, publicFailureMessage } from '@/lib/llm/failure-class'
import { isMandatoryAnalystError, primaryPipelineError } from '@/lib/pipeline/mandatory-analyst'

/**
 * Redaction helpers for secrets in architecture data, errors, and logs.
 */

const REDACTED = '[REDACTED]'

const SECRET_VALUE_RE =
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk|rk|key|token|secret|password|passwd|api[_-]?key)[-_a-z0-9]*\s*[:=]\s*\S+/gi

/** scheme://user:password@host — named-secret patterns miss URI userinfo. */
const URI_USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s@]*):([^/\s@]+)@/g

const SENSITIVE_NAME_RE =
  /(secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|bearer)/i

export function redactSecretsInText(text: string): string {
  return text
    .replace(SECRET_VALUE_RE, REDACTED)
    .replace(URI_USERINFO_RE, `$1$2:${REDACTED}@`)
}

/** Stable client-facing error — full detail stays in server logs only. */
export function toPublicErrorMessage(err: unknown, fallback = 'An unexpected error occurred'): string {
  const primary = primaryPipelineError(err)
  if (isAbortLike(primary) && !isMandatoryAnalystError(primary)) return 'Stopped by user'
  if (isProviderBillingError(primary)) return new ProviderBillingError().message

  const classified = classifyFailure(primary)
  if (classified === 'reference' || classified === 'invalid_json' || classified === 'truncation'
    || classified === 'insufficient_context' || classified === 'authentication' || classified === 'billing'
    || classified === 'transport' || classified === 'validation' || classified === 'invalid_params'
    || classified === 'rate_limit') {
    return publicFailureMessage(primary, fallback)
  }

  if (primary instanceof Error && primary.name === 'PhaseTimeoutError') {
    return 'An analysis phase exceeded its time budget. Review the phase workload and timeout configuration before resuming.'
  }
  if (isMandatoryAnalystError(primary)) return primary.message

  const raw = primary instanceof Error ? primary.message : String(primary)
  const lower = raw.toLowerCase()
  if (lower.includes('pipeline timed out after')) return 'Pipeline timed out'
  if (lower.includes('structured llm call timed out') || lower.includes('timed out after')) {
    return 'The model call timed out'
  }
  if (classified === 'timeout' || lower.includes('timeout') || lower.includes('timed out')) {
    return 'The model call timed out'
  }
  if (lower.includes('superseded by cancellation') || lower.includes('stopped by user')) {
    return 'Stopped by user'
  }
  if (lower.includes('unauthorized') || lower.includes('forbidden')) {
    return 'Request was not authorized'
  }
  return fallback
}

export function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return (err as { name?: string }).name === 'AbortError'
}

export type EnvVarLike = {
  name: string
  value?: string
  isSensitive: boolean
  component: string
}

export function redactEnvironmentVars<T extends EnvVarLike>(vars: T[]): T[] {
  return vars.map((v) => {
    const sensitive = v.isSensitive || SENSITIVE_NAME_RE.test(v.name)
    if (!sensitive) {
      if (v.value && SECRET_VALUE_RE.test(v.value)) {
        SECRET_VALUE_RE.lastIndex = 0
        return { ...v, isSensitive: true, value: REDACTED }
      }
      return v
    }
    return { ...v, isSensitive: true, value: v.value ? REDACTED : v.value }
  })
}

export function redactArchitectureSecrets<T>(architecture: T): T {
  if (!architecture || typeof architecture !== 'object') return architecture
  const arch = architecture as {
    detailedTopology?: { environmentVars?: EnvVarLike[]; [k: string]: unknown }
    [k: string]: unknown
  }
  const envVars = arch.detailedTopology?.environmentVars
  if (!envVars?.length) return architecture

  return {
    ...arch,
    detailedTopology: {
      ...arch.detailedTopology,
      environmentVars: redactEnvironmentVars(envVars),
    },
  } as T
}
