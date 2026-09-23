import { classifyFailure, publicFailureMessage } from '@/lib/llm/failure-class'

/** A required analyst exhausted its budget. Remaining stages must not start. */
export class MandatoryAnalystError extends Error {
  readonly code = 'MANDATORY_ANALYST_FAILED'
  readonly analyst: string
  readonly failureClass: ReturnType<typeof classifyFailure>
  override readonly cause: unknown

  constructor(analyst: string, cause: unknown) {
    super(`${analyst}: ${publicFailureMessage(cause, 'analyst failed')}`)
    this.name = 'MandatoryAnalystError'
    this.analyst = analyst
    this.cause = cause
    this.failureClass = classifyFailure(cause)
  }
}

export function isMandatoryAnalystError(error: unknown): error is MandatoryAnalystError {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'MandatoryAnalystError')
}

export function isDerivedCancellation(error: unknown, signal?: AbortSignal): boolean {
  const reason = signal?.reason ?? (error as { cause?: unknown } | null)?.cause
  return isMandatoryAnalystError(reason) && !isMandatoryAnalystError(error)
}

export function primaryPipelineError(error: unknown, signal?: AbortSignal): unknown {
  if (isMandatoryAnalystError(error)) return error
  const reason = signal?.reason
  if (isMandatoryAnalystError(reason)) return reason
  if (error && typeof error === 'object' && isMandatoryAnalystError((error as { cause?: unknown }).cause)) {
    return (error as { cause: unknown }).cause
  }
  return error
}
