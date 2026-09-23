import { AsyncLocalStorage } from 'node:async_hooks'
import { redactSecretsInText } from '@/lib/utils/redact'
import { classifyFailure, rejectedFieldsOf, type FailureClass } from './failure-class'
import { modelNameOf, providerNameOf } from './usage'

export const MAX_REJECTED_RESPONSE_CHARS = 65_536

export type AttemptDiagnostic = {
  at: string
  provider: string
  model: string
  phase: string
  mechanism: string
  durationMs: number
  inputTokens: number | null
  outputTokens: number | null
  waitMs: number | null
  loadMs: number | null
  processingMs: number | null
  generationMs: number | null
  errorClass: FailureClass | null
  rejectedFields: string[]
  rejectedResponseTruncated: boolean
  rejectedResponseChars: number
}

export type AttemptSink = {
  runId: string
  record: (diagnostic: AttemptDiagnostic, rejectedResponse?: string) => Promise<void>
}

const attemptScope = new AsyncLocalStorage<AttemptSink>()

export function runWithAttemptSink<T>(sink: AttemptSink, fn: () => Promise<T>): Promise<T> {
  return attemptScope.run(sink, fn)
}

export function currentAttemptSink(): AttemptSink | undefined {
  return attemptScope.getStore()
}

export function sanitizeRejectedResponse(raw: string): { text: string; truncated: boolean } {
  const redacted = redactSecretsInText(raw)
  if (redacted.length <= MAX_REJECTED_RESPONSE_CHARS) return { text: redacted, truncated: false }
  return {
    text: `${redacted.slice(0, MAX_REJECTED_RESPONSE_CHARS)}\n[truncated after ${MAX_REJECTED_RESPONSE_CHARS} characters; original length ${redacted.length}]`,
    truncated: true,
  }
}

export async function recordStructuredAttempt(params: {
  llm: unknown
  phase: string
  mechanism: string
  durationMs: number
  error?: unknown
  rawOutput?: string
  usage?: { input_tokens?: number; output_tokens?: number } | undefined
  timings?: { waitMs?: number; loadMs?: number; processingMs?: number; generationMs?: number }
}): Promise<void> {
  const sink = attemptScope.getStore()
  if (!sink) return
  const rejected = params.rawOutput ? sanitizeRejectedResponse(params.rawOutput) : null
  const diagnostic: AttemptDiagnostic = {
    at: new Date().toISOString(),
    provider: providerNameOf(params.llm),
    model: modelNameOf(params.llm) ?? 'unknown',
    phase: params.phase,
    mechanism: params.mechanism,
    durationMs: params.durationMs,
    inputTokens: params.usage?.input_tokens ?? null,
    outputTokens: params.usage?.output_tokens ?? null,
    waitMs: params.timings?.waitMs ?? null,
    loadMs: params.timings?.loadMs ?? null,
    processingMs: params.timings?.processingMs ?? null,
    generationMs: params.timings?.generationMs ?? null,
    errorClass: params.error ? classifyFailure(params.error) : null,
    rejectedFields: params.error ? rejectedFieldsOf(params.error) : [],
    rejectedResponseTruncated: rejected?.truncated ?? false,
    rejectedResponseChars: params.rawOutput?.length ?? 0,
  }
  await sink.record(diagnostic, rejected?.text)
}
