import { createHash } from 'node:crypto'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { z } from 'zod'
import { modelNameOf, providerNameOf } from '@/lib/llm/usage'

type CacheEntry = { value: unknown; expiresAt: number }

const entries = new Map<string, CacheEntry>()

function enabled(): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env.LLM_RESPONSE_CACHE_ENABLED ?? '')
}

function positiveInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    )
  }
  return value
}

function temperatureOf(llm: BaseChatModel): number | string {
  if (providerNameOf(llm) === 'cursor') return 'unsupported'
  const temperature = (llm as BaseChatModel & { temperature?: unknown }).temperature
  return typeof temperature === 'number' ? temperature : 'default'
}

export function structuredResponseCacheKey(params: {
  llm: BaseChatModel
  schema: z.ZodType
  systemPrompt: string
  userMessage: string
}): string | null {
  if (!enabled()) return null
  let jsonSchema: unknown
  try {
    jsonSchema = z.toJSONSchema(params.schema)
  } catch {
    return null
  }
  return createHash('sha256').update(JSON.stringify(stable({
    provider: providerNameOf(params.llm),
    model: modelNameOf(params.llm),
    temperature: temperatureOf(params.llm),
    schema: jsonSchema,
    systemPrompt: params.systemPrompt,
    userMessage: params.userMessage,
  }))).digest('hex')
}

export function getStructuredResponse<T>(key: string | null, schema: z.ZodType<T>): T | null {
  if (!key) return null
  const entry = entries.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key)
    return null
  }
  entries.delete(key)
  entries.set(key, entry)
  const parsed = schema.safeParse(entry.value)
  if (!parsed.success) {
    entries.delete(key)
    return null
  }
  return parsed.data
}

export function setStructuredResponse(key: string | null, value: unknown): void {
  if (!key) return
  const now = Date.now()
  for (const [candidate, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(candidate)
  }
  entries.delete(key)
  entries.set(key, {
    value: structuredClone(value),
    expiresAt: now + positiveInteger('LLM_RESPONSE_CACHE_TTL_MS', 1_800_000),
  })
  const maxEntries = positiveInteger('LLM_RESPONSE_CACHE_MAX_ENTRIES', 500)
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next().value as string | undefined
    if (!oldest) break
    entries.delete(oldest)
  }
}

export function _clearStructuredResponseCache(): void {
  entries.clear()
}
