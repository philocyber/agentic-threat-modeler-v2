/**
 * Provider-agnostic structured output invocation (v2, fase 1).
 *
 * Common entry point the agent layer will migrate to: one call, one Zod schema,
 * and the strongest mechanism the underlying provider natively supports:
 *
 *   - Gemini  (@langchain/google-genai): withStructuredOutput() — Gemini
 *     responseSchema enforcement. Same pattern as lib/llm/structured-output.ts.
 *   - Ollama  (@langchain/ollama): withStructuredOutput({ method: 'jsonSchema' })
 *     — passes the JSON schema as Ollama's native `format` parameter (server-side
 *     grammar-constrained decoding, Ollama >= 0.5). Stronger than `format: 'json'`.
 *   - Kimi/Moonshot (@langchain/openai): withStructuredOutput({ method:
 *     'jsonSchema', strict: true }) — response_format: { type: 'json_schema' }.
 *     Supported by the Moonshot chat-completions API (platform.kimi.ai docs).
 *   - Bedrock (@langchain/aws Converse): withStructuredOutput() — tool-use with
 *     forced toolChoice ('jsonMode' is explicitly unsupported by the SDK).
 *   - Anything else: schema injected into the system prompt + JSON.parse + Zod.
 *
 * Regardless of mechanism, the result is ALWAYS validated against the Zod schema
 * here; a mismatch raises StructuredOutputError carrying the Zod issues so the
 * caller can retry with the error fed back into the prompt.
 */

import { ChatOllama } from '@langchain/ollama'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { ChatOpenAI } from '@langchain/openai'
import { ChatBedrockConverse } from '@langchain/aws'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { z } from 'zod'
import { coerceToSchema } from '@/lib/llm/coerce'
import {
  assertRunCostBudget,
  recordProviderFailure,
} from '@/lib/llm/usage'
import { accountModelCall } from '@/lib/llm/call-accounting'
import { recordStructuredAttempt } from '@/lib/llm/attempt-diagnostics'
import { ollamaTimingsFromMetadata } from '@/lib/llm/ollama-queue'
import { fitMessagesToModelContext } from '@/lib/llm/context-guard'
import {
  getStructuredResponse,
  setStructuredResponse,
  structuredResponseCacheKey,
} from '@/lib/llm/response-cache'

export const DEFAULT_STRUCTURED_TIMEOUT_MS = 120_000
const OLLAMA_STRUCTURED_TIMEOUT_MS = 300_000
/**
 * Reasoning models emit the whole schema in one response, so a full architecture
 * or threat batch routinely runs past two minutes: a 21 KB input measured 153s
 * (5.8k prompt tokens in, 6.6k completion tokens out) against kimi-k2.6.
 * Override with STRUCTURED_TIMEOUT_MS when a provider is slower still.
 */
const REMOTE_STRUCTURED_TIMEOUT_MS = 300_000

function configuredTimeoutMs(): number | null {
  const raw = process.env.STRUCTURED_TIMEOUT_MS
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export type StructuredOutputMechanism =
  | 'gemini-structured-output'
  | 'ollama-json-schema'
  | 'openai-json-schema'
  | 'bedrock-tool-use'
  | 'prompt-fallback'

/** Which native mechanism invokeStructured() will use for a given model. */
export function selectStructuredMechanism(llm: BaseChatModel): StructuredOutputMechanism {
  if (llm instanceof ChatGoogleGenerativeAI) return 'gemini-structured-output'
  if (llm instanceof ChatOllama) return 'ollama-json-schema'
  if (llm instanceof ChatOpenAI) return 'openai-json-schema'
  if (llm instanceof ChatBedrockConverse) return 'bedrock-tool-use'
  return 'prompt-fallback'
}

/**
 * Raised when the model responded but its output does not satisfy the Zod
 * schema (or is not parseable JSON at all). Carries everything a retry loop
 * needs to feed the failure back into the next prompt.
 */
export class StructuredOutputError extends Error {
  readonly agentName: string
  readonly mechanism: StructuredOutputMechanism
  /** Zod issues; empty when the raw output was not even parseable JSON. */
  readonly issues: z.ZodError['issues']
  /** Raw model output (text, or JSON-stringified object for native paths). */
  readonly rawOutput: string

  constructor(params: {
    agentName: string
    mechanism: StructuredOutputMechanism
    issues: z.ZodError['issues']
    rawOutput: string
  }) {
    const summary =
      params.issues.length > 0
        ? params.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')
        : 'output was not parseable JSON'
    super(
      `[${params.agentName}] structured output failed Zod validation (${params.mechanism}): ${summary}`
    )
    this.name = 'StructuredOutputError'
    this.agentName = params.agentName
    this.mechanism = params.mechanism
    this.issues = params.issues
    this.rawOutput = params.rawOutput
  }
}

/**
 * Raised when the model stopped because it hit its output token ceiling. This is
 * distinct from invalid JSON: retrying the identical request truncates again, so
 * the caller must shrink the request instead of repeating it.
 */
export class StructuredOutputTruncatedError extends Error {
  readonly agentName: string
  readonly mechanism: StructuredOutputMechanism
  readonly outputTokens: number | null
  constructor(params: {
    agentName: string
    mechanism: StructuredOutputMechanism
    outputTokens: number | null
  }) {
    super(
      `[${params.agentName}] model hit its output token limit (${params.mechanism})` +
        (params.outputTokens ? ` after ${params.outputTokens} tokens` : '') +
        ' — the response was cut mid-structure',
    )
    this.name = 'StructuredOutputTruncatedError'
    this.agentName = params.agentName
    this.mechanism = params.mechanism
    this.outputTokens = params.outputTokens
  }
}

/**
 * Every provider signals "I ran out of output budget" under its own key, so the
 * check stays provider-agnostic: OpenAI-compatible (`length`), Gemini
 * (`MAX_TOKENS`), Bedrock Converse (`max_tokens`) and Ollama (`length`).
 */
const TRUNCATION_SIGNALS = new Set(['length', 'max_tokens', 'maxtokens'])

function truncationTokens(message: unknown): number | null {
  const usage = (message as { usage_metadata?: { output_tokens?: number } } | null)?.usage_metadata
  return typeof usage?.output_tokens === 'number' ? usage.output_tokens : null
}

export function isTruncatedResponse(message: unknown): boolean {
  const metadata = (message as { response_metadata?: Record<string, unknown> } | null)?.response_metadata
  if (!metadata) return false
  for (const key of ['finish_reason', 'finishReason', 'stopReason', 'stop_reason', 'done_reason']) {
    const value = metadata[key]
    if (typeof value === 'string' && TRUNCATION_SIGNALS.has(value.toLowerCase().replace(/[\s-]/g, '_'))) {
      return true
    }
  }
  return false
}

/**
 * Turns whatever a provider adapter reports for a failed parse into a
 * StructuredOutputError. Shapes seen in the wild: a real ZodError, an object
 * carrying `.issues`, and a plain Error whose message is the JSON-serialized
 * issue array. All three must end up classified as `validation`, because that
 * is the only class whose retry feeds the schema complaints back to the model.
 */
function toStructuredOutputError(
  err: unknown,
  agentName: string,
  mechanism: StructuredOutputMechanism,
): StructuredOutputError {
  if (err instanceof StructuredOutputError) return err

  const issues = extractZodIssues(err)
  const message = err instanceof Error ? err.message : String(err)
  return new StructuredOutputError({
    agentName,
    mechanism,
    issues,
    rawOutput: issues.length > 0 ? '' : message.slice(0, 4000),
  })
}

/**
 * Recovers a mis-wrapped payload straight from the provider message, so a
 * response that already carries the right content is never re-requested.
 */
function repairFromRawMessage<T>(raw: unknown, schema: z.ZodType<T>): T | null {
  const content = (raw as { content?: unknown } | null)?.content
  if (content === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(messageContentToText(content))
  } catch {
    return null
  }
  const coerced = coerceToSchema(parsed, schema)
  return coerced.ok ? coerced.data : null
}

function extractZodIssues(err: unknown): z.ZodError['issues'] {
  if (err instanceof z.ZodError) return err.issues

  const direct = (err as { issues?: unknown } | null)?.issues
  if (Array.isArray(direct)) return direct as z.ZodError['issues']

  const cause = (err as { cause?: unknown } | null)?.cause
  if (cause instanceof z.ZodError) return cause.issues

  // LangChain serializes the issue array into the message on some paths.
  const message = err instanceof Error ? err.message : ''
  if (message.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(message) as unknown
      if (Array.isArray(parsed) && parsed.every((i) => i && typeof i === 'object' && 'message' in i)) {
        return parsed as z.ZodError['issues']
      }
    } catch {
      // Not the serialized form; fall through to an issue-less error.
    }
  }
  return []
}

/** Raised when the call exceeds timeoutMs (distinct from an external abort). */
export class StructuredOutputTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(agentName: string, timeoutMs: number) {
    super(`[${agentName}] structured LLM call timed out after ${timeoutMs}ms`)
    this.name = 'TimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export interface InvokeStructuredParams<T> {
  llm: BaseChatModel
  schema: z.ZodType<T>
  systemPrompt: string
  userMessage: string
  agentName: string
  /** Per-call timeout. Default: 300s for local Ollama, 120s for remote providers. */
  timeoutMs?: number
  /** Expected response budget for context planning when this schema is smaller than the model-wide ceiling. */
  outputTokenReserve?: number | undefined
  /** External cancellation signal (pipeline stop). */
  signal?: AbortSignal | undefined
}

/**
 * Meta keywords Zod emits for standalone documents. They describe the schema,
 * not the data, and no provider's constraint parameter accepts them.
 *
 * `$schema` is not cosmetic: sending it to Moonshot makes the model answer with
 * a few tokens of garbage instead of the requested object — measured against
 * kimi-k2.6, where the identical schema without it returned all 25 assessments.
 * The request still succeeds, so the damage only surfaces later as a phase that
 * "failed validation": the entire debate and DREAD degradation traced back here.
 */
const SCHEMA_META_KEYS = new Set(['$schema', '$id', '$comment'])

function stripSchemaMeta(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaMeta)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_META_KEYS.has(key)) continue
    out[key] = stripSchemaMeta(value)
  }
  return out
}

/**
 * Rewrites a JSON Schema to the contract OpenAI-compatible providers require
 * under `strict: true`: every object closed with `additionalProperties: false`,
 * and every property listed in `required`. Optional properties keep their
 * meaning by also accepting null, which is the substitution OpenAI documents.
 * Real OpenAI rejects the request outright without this; Moonshot accepts it
 * either way, so normalizing keeps one code path for every provider on the
 * chat-completions contract.
 *
 * The nulls it invites back are removed from the response by `restoreOptionalNulls` before
 * Zod sees them, so an optional field stays optional.
 */
function toStrictJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictJsonSchema)
  if (node === null || typeof node !== 'object') return node

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) out[key] = toStrictJsonSchema(value)

  const properties = out.properties
  if (out.type === 'object' && properties !== null && typeof properties === 'object') {
    out.additionalProperties = false
    const names = Object.keys(properties)
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : [])
    const widened = properties as Record<string, unknown>
    for (const name of names) {
      if (!required.has(name)) widened[name] = { anyOf: [widened[name], { type: 'null' }] }
    }
    out.required = names
  }
  return out
}

/** Restore only nulls introduced for optional fields, preserving real nullable data. */
export function restoreOptionalNulls(value: unknown, schema: Record<string, unknown>, root = schema): unknown {
  const visited = new Set<string>()
  while (typeof schema.$ref === 'string' && (schema.$ref === '#' || schema.$ref.startsWith('#/')) && !visited.has(schema.$ref)) {
    visited.add(schema.$ref)
    let target: unknown = root
    for (const part of schema.$ref === '#' ? [] : schema.$ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
      target = target && typeof target === 'object' ? (target as Record<string, unknown>)[key] : undefined
    }
    if (!target || typeof target !== 'object' || Array.isArray(target)) break
    schema = target as Record<string, unknown>
  }
  const alternatives = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined
  const nonNull = alternatives?.filter(node => node.type !== 'null')
  if (value !== null && nonNull?.length === 1) return restoreOptionalNulls(value, nonNull[0]!, root)
  if (Array.isArray(value)) return value.map(item => restoreOptionalNulls(item, (schema.items ?? {}) as Record<string, unknown>, root))
  if (value === null || typeof value !== 'object') return value
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((schema.required ?? []) as string[])
  const acceptsNull = (node: Record<string, unknown>): boolean => node.type === 'null'
    || (Array.isArray(node.type) && node.type.includes('null'))
    || (Array.isArray(node.enum) && node.enum.includes(null))
    || (Array.isArray(node.anyOf) && node.anyOf.some(child => acceptsNull(child as Record<string, unknown>)))
    || (Array.isArray(node.oneOf) && node.oneOf.some(child => acceptsNull(child as Record<string, unknown>)))
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    const property = properties[key]
    // Unrecognized/union/ref shapes stay untouched and undergo normal Zod validation.
    if (entry === null && property && !required.has(key) && !acceptsNull(property)) continue
    out[key] = restoreOptionalNulls(entry, property ?? {}, root)
  }
  return out
}

/**
 * Converts a Zod schema for a provider's schema-enforcement parameter.
 *
 * Several agent schemas trim or normalize fields with `.transform()`, which has
 * no JSON Schema representation: the default conversion throws, which killed the
 * synthesizer and the validator before a single request left the process. The
 * transform only matters when parsing the response, so the constraint sent to
 * the provider describes the input shape and leaves the rest unconstrained.
 * A schema that still cannot be converted returns null, and the caller falls
 * back to describing it in the prompt rather than failing the phase.
 */
function toProviderJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> | null {
  try {
    const converted = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
    return stripSchemaMeta(converted) as Record<string, unknown>
  } catch {
    return null
  }
}

export function buildSchemaInstruction(schema: z.ZodType<unknown>): string {
  // Describe the input contract just like native providers. Transforms apply
  // only after parsing and must not erase the schema for prompt-based adapters.
  const jsonSchema = toProviderJsonSchema(schema)
  return [
    'Respond ONLY with a single JSON object (no markdown fences, no prose) that conforms to this JSON Schema:',
    jsonSchema ? JSON.stringify(jsonSchema) : '(schema unavailable — follow the field names described above)',
  ].join('\n')
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part !== null && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : ''
      )
      .join('')
  }
  return JSON.stringify(content)
}

/**
 * Text-only provider adapters occasionally return otherwise valid JSON with a
 * literal tab or newline inside a quoted excerpt. JSON requires those control
 * characters to be escaped. Repair only characters encountered while inside a
 * string; structural whitespace and every other byte remain unchanged.
 */
function escapeJsonStringControlCharacters(text: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (!inString) {
      output += char
      if (char === '"') inString = true
      continue
    }
    if (escaped) {
      output += code <= 0x1f ? `u${code.toString(16).padStart(4, '0')}` : char
      escaped = false
      continue
    }
    if (char === '\\') {
      output += char
      escaped = true
      continue
    }
    if (char === '"') {
      output += char
      inString = false
      continue
    }
    output += code <= 0x1f ? `\\u${code.toString(16).padStart(4, '0')}` : char
  }
  return output
}

function parseJsonCandidate(candidate: string): unknown {
  try {
    return JSON.parse(candidate)
  } catch {
    return JSON.parse(escapeJsonStringControlCharacters(candidate))
  }
}

/** Extract the first JSON payload from free text (fences / surrounding prose). */
function parseJsonFromText(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  try {
    return parseJsonCandidate(cleaned)
  } catch {
    /* fall through */
  }
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1]) return parseJsonCandidate(fence[1].trim())
  // Last resort: largest balanced {...} / [...] region.
  const start = cleaned.search(/[{[]/)
  if (start >= 0) {
    const open = cleaned[start]!
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i]!
      if (esc) { esc = false; continue }
      if (inStr) {
        if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') { inStr = true; continue }
      if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) return parseJsonCandidate(cleaned.slice(start, i + 1))
      }
    }
  }
  throw new Error('no JSON payload found in model output')
}

/**
 * Invoke a chat model with native structured-output enforcement and mandatory
 * Zod validation.
 *
 * Throws:
 *  - StructuredOutputError        — model answered, but output failed the schema
 *  - StructuredOutputTimeoutError — per-call timeout exceeded
 *  - Error with name 'AbortError' — the external `signal` aborted
 *  - provider/network errors      — rethrown as-is
 */
export async function invokeStructured<T>(params: InvokeStructuredParams<T>): Promise<T> {
  const {
    llm,
    schema,
    systemPrompt,
    userMessage,
    agentName,
    timeoutMs: requestedTimeoutMs,
    outputTokenReserve,
    signal,
  } = params

  if (signal?.aborted) {
    const err = new Error('Stopped by user')
    err.name = 'AbortError'
    throw err
  }

  const responseCacheKey = structuredResponseCacheKey({ llm, schema, systemPrompt, userMessage })
  const cached = getStructuredResponse(responseCacheKey, schema)
  if (cached !== null) return cached

  const mechanism = selectStructuredMechanism(llm)
  // Grammar-constrained local generation can legitimately take more than two
  // minutes on laptop GPUs, especially for array-heavy threat schemas. Hosted
  // reasoning models hit the same wall on large inputs, so only the cheap
  // prompt fallback keeps the short default.
  const timeoutMs = requestedTimeoutMs ?? configuredTimeoutMs() ?? (
    mechanism === 'ollama-json-schema'
      ? OLLAMA_STRUCTURED_TIMEOUT_MS
      : mechanism === 'prompt-fallback'
        ? DEFAULT_STRUCTURED_TIMEOUT_MS
        : REMOTE_STRUCTURED_TIMEOUT_MS
  )

  // Compose external cancellation with the per-call timeout. The combined signal
  // is passed to LangChain AND raced below, so the timeout fires even if a
  // provider SDK ignores abort signals.
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  const messages = fitMessagesToModelContext(llm, [new SystemMessage(systemPrompt), new HumanMessage(userMessage)], outputTokenReserve)
  let responseMessage: unknown
  const captureResponse = <T>(result: T): T => { responseMessage = result; return result }
  const invoke = (input: Parameters<BaseChatModel['invoke']>[0], options: Parameters<BaseChatModel['invoke']>[1]) =>
    accountModelCall(llm, agentName, () => llm.invoke(input, options)).then(captureResponse)

  const run = async (): Promise<unknown> => {
    assertRunCostBudget()
    if (mechanism === 'prompt-fallback') {
      const response = await invoke(
        fitMessagesToModelContext(llm, [
          new SystemMessage(`${systemPrompt}\n\n${buildSchemaInstruction(schema)}`),
          new HumanMessage(userMessage),
        ], outputTokenReserve),
        { signal: combined }
      )
      if (isTruncatedResponse(response)) {
        throw new StructuredOutputTruncatedError({
          agentName,
          mechanism,
          outputTokens: truncationTokens(response),
        })
      }
      const text = messageContentToText(response.content)
      let parsed: unknown
      try {
        parsed = parseJsonFromText(text)
      } catch {
        throw new StructuredOutputError({
          agentName,
          mechanism,
          issues: [],
          rawOutput: text,
        })
      }
      return parsed
    }

    // The schema is enforced by the provider, but the response is parsed here
    // rather than inside withStructuredOutput. That wrapper raises the parse
    // failure as an LLM error, which hides the generated text: the payload can
    // no longer be repaired, and the error arrives from LangChain's own zod copy
    // so `instanceof` misses it and it classifies as `unknown`. Owning the parse
    // keeps both the text and the error shape under our control.
    const jsonSchema = toProviderJsonSchema(schema)
    // Provider-native schema enforcement, expressed through each adapter's call
    // options instead of withStructuredOutput.
    // Without a convertible schema the provider cannot enforce anything, so the
    // request goes out with the shape described in the prompt instead of the
    // phase dying before it starts.
    const constrainedOptions: Record<string, unknown> | null =
      jsonSchema === null
        ? null
        : mechanism === 'openai-json-schema'
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: `${agentName}_output`,
                schema: toStrictJsonSchema(jsonSchema),
                strict: true,
              },
            },
          }
        : mechanism === 'ollama-json-schema'
          ? { format: jsonSchema }
          : mechanism === 'gemini-structured-output'
            ? { responseMimeType: 'application/json', responseSchema: jsonSchema }
            : null

    if (!constrainedOptions && mechanism !== 'bedrock-tool-use') {
      const response = await invoke(
        fitMessagesToModelContext(llm, [
          new SystemMessage(`${systemPrompt}

${buildSchemaInstruction(schema)}`),
          new HumanMessage(userMessage),
        ], outputTokenReserve),
        { signal: combined },
      )
      if (isTruncatedResponse(response)) {
        throw new StructuredOutputTruncatedError({
          agentName,
          mechanism,
          outputTokens: truncationTokens(response),
        })
      }
      const text = messageContentToText(response.content)
      try {
        return parseJsonFromText(text)
      } catch {
        throw new StructuredOutputError({ agentName, mechanism, issues: [], rawOutput: text })
      }
    }

    // Bedrock Converse enforces its schema through forced tool use, which has no
    // response_format equivalent; it keeps the SDK path.
    if (!constrainedOptions) {
      const structured = (llm as ChatBedrockConverse).withStructuredOutput(schema, {
        name: `${agentName}_output`,
        includeRaw: true,
      })
      const result = (await accountModelCall(llm, agentName, () => structured.invoke(messages, { signal: combined }), result => captureResponse(result.raw))) as {
        raw?: unknown
        parsed?: unknown
        parsingError?: unknown
      }
      if (isTruncatedResponse(result.raw)) {
        throw new StructuredOutputTruncatedError({
          agentName,
          mechanism,
          outputTokens: truncationTokens(result.raw),
        })
      }
      if (result.parsingError) {
        const repaired = repairFromRawMessage(result.raw, schema)
        if (repaired) return repaired
        throw toStructuredOutputError(result.parsingError, agentName, mechanism)
      }
      return result.parsed
    }

    const response = await invoke(messages, {
      signal: combined,
      ...constrainedOptions,
    } as never)
    if (isTruncatedResponse(response)) {
      throw new StructuredOutputTruncatedError({
        agentName,
        mechanism,
        outputTokens: truncationTokens(response),
      })
    }

    const text = messageContentToText(response.content)
    try {
      // Strict mode expresses "optional" as "may be null", so the nulls it
      // produces are stripped back out before the schema sees them.
      return mechanism === 'openai-json-schema' ? restoreOptionalNulls(parseJsonFromText(text), jsonSchema ?? {}) : parseJsonFromText(text)
    } catch {
      throw new StructuredOutputError({
        agentName,
        mechanism,
        issues: [],
        rawOutput: text,
      })
    }
  }

  const attemptStarted = Date.now()
  const observations = () => {
    const response = responseMessage as { usage_metadata?: { input_tokens?: number; output_tokens?: number }; response_metadata?: Record<string, unknown> } | undefined
    const timings = ollamaTimingsFromMetadata(response?.response_metadata)
    const waitMs = (llm as BaseChatModel & { lastInferenceWaitMs?: number }).lastInferenceWaitMs
    return {
      usage: response?.usage_metadata,
      timings: {
        ...(waitMs !== undefined ? { waitMs } : {}),
        ...(timings.loadMs !== null ? { loadMs: timings.loadMs } : {}),
        ...(timings.processingMs !== null ? { processingMs: timings.processingMs } : {}),
        ...(timings.generationMs !== null ? { generationMs: timings.generationMs } : {}),
      },
    }
  }
  const noteFailure = async (error: unknown): Promise<void> => {
    const content = (responseMessage as { content?: unknown } | undefined)?.content
    const rawOutput = error instanceof StructuredOutputError && error.rawOutput
      ? error.rawOutput : content !== undefined ? messageContentToText(content) : undefined
    await recordStructuredAttempt({
      llm,
      phase: agentName,
      mechanism,
      durationMs: Date.now() - attemptStarted,
      error,
      ...observations(),
      ...(rawOutput ? { rawOutput } : {}),
    })
  }

  let raw: unknown
  try {
    raw = await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        if (signal?.aborted) {
          const err = new Error('Stopped by user')
          err.name = 'AbortError'
          reject(err)
        } else {
          reject(new StructuredOutputTimeoutError(agentName, timeoutMs))
        }
      }
      combined.addEventListener('abort', onAbort, { once: true })
      run().then(
        (value) => {
          combined.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (err) => {
          combined.removeEventListener('abort', onAbort)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      )
    })
  } catch (err) {
    const billingFailure = recordProviderFailure(err)
    if (billingFailure) {
      await noteFailure(billingFailure)
      throw billingFailure
    }
    if (err instanceof z.ZodError) {
      const error = new StructuredOutputError({
        agentName,
        mechanism,
        issues: err.issues,
        rawOutput: '',
      })
      await noteFailure(error)
      throw error
    }
    if (err instanceof Error && err.name === 'OutputParserException') {
      const cause = (err as { cause?: unknown }).cause ?? (err as { error?: unknown }).error
      const error = new StructuredOutputError({
        agentName,
        mechanism,
        issues: cause instanceof z.ZodError ? cause.issues : [],
        rawOutput: cause instanceof z.ZodError ? '' : err.message.slice(0, 4000),
      })
      await noteFailure(error)
      throw error
    }
    await noteFailure(err)
    throw err
  }

  // Final mandatory validation — native mechanisms guarantee syntax, not semantics
  // (and the Bedrock tool-use path performs no Zod validation inside the SDK).
  const coerced = coerceToSchema(raw, schema)
  if (coerced.ok) {
    setStructuredResponse(responseCacheKey, coerced.data)
    await recordStructuredAttempt({ llm, phase: agentName, mechanism, durationMs: Date.now() - attemptStarted, ...observations() })
    return coerced.data
  }

  try {
    const parsed = schema.parse(raw)
    setStructuredResponse(responseCacheKey, parsed)
    await recordStructuredAttempt({ llm, phase: agentName, mechanism, durationMs: Date.now() - attemptStarted, ...observations() })
    return parsed
  } catch (err) {
    if (err instanceof z.ZodError) {
      let rawOutput: string
      try {
        rawOutput = JSON.stringify(raw) ?? String(raw)
      } catch {
        rawOutput = String(raw)
      }
      const error = new StructuredOutputError({ agentName, mechanism, issues: err.issues, rawOutput })
      await noteFailure(error)
      throw error
    }
    await noteFailure(err)
    throw err
  }
}
