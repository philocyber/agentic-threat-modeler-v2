import { z } from 'zod'

/**
 * Wrapper keys the agents' schemas use for their single array payload. When a
 * model answers with the bare array instead of the wrapper object, the shape is
 * recoverable without another call.
 */
const WRAP_KEYS = [
  'threats',
  'validations',
  'threatAssessments',
  'components',
  'dataFlows',
  'items',
  'results',
  'data',
] as const

/**
 * Validates `raw` against `schema`, repairing the one mismatch models produce
 * constantly: returning `[...]` where the schema expects `{ key: [...] }`.
 *
 * This runs before any retry on purpose. Re-prompting for a shape the response
 * already contains costs a full generation — minutes and real money on a hosted
 * reasoning model — to recover data that is right there.
 */
export function coerceToSchema<T>(raw: unknown, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false } {
  const direct = schema.safeParse(raw)
  if (direct.success) return { ok: true, data: direct.data }

  if (Array.isArray(raw)) {
    for (const key of WRAP_KEYS) {
      const wrapped = schema.safeParse({ [key]: raw })
      if (wrapped.success) return { ok: true, data: wrapped.data }
    }
  }

  // A single object where a list is expected is the mirror case.
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of WRAP_KEYS) {
      const wrapped = schema.safeParse({ [key]: [raw] })
      if (wrapped.success) return { ok: true, data: wrapped.data }
    }
  }

  return { ok: false }
}
