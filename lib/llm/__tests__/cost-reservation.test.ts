import { afterEach, describe, expect, it } from 'vitest'
import { UnpricedModelError, estimateCallUsd, reserveRunCost, heldReservationUsd } from '../cost-reservation'
import { emptyUsage, runWithUsage, RunCostLimitError } from '../usage'
import { z } from 'zod'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { invokeStructured } from '../structured'

afterEach(() => {
  delete process.env.LLM_PRICES_JSON
  delete process.env.MAX_RUN_COST_USD
})

describe('cost reservation', () => {
  const llm = (content: string, usage?: { input_tokens: number; output_tokens: number }) => ({
    providerName: 'kimi', model: 'test', contextWindow: 100_000, outputTokenReserve: 1_000,
    invoke: async () => ({ content, ...(usage ? { usage_metadata: usage } : {}) }),
  }) as unknown as BaseChatModel
  const call = (model: BaseChatModel) => invokeStructured({
    llm: model, schema: z.object({ ok: z.boolean() }), agentName: 'BudgetReview',
    systemPrompt: 'Return JSON.', userMessage: 'Synthetic fixture.',
  })

  it('retains a hold when a valid response has no usage metadata', async () => {
    process.env.LLM_PRICES_JSON = JSON.stringify({ test: { input: 1, output: 1 } })
    process.env.MAX_RUN_COST_USD = '1'
    await runWithUsage(emptyUsage(), async () => {
      await call(llm('{"ok":true}'))
      expect(heldReservationUsd()).toBeGreaterThan(0)
    })
  })

  it('releases a hold after reported usage even when schema validation fails', async () => {
    process.env.LLM_PRICES_JSON = JSON.stringify({ test: { input: 1, output: 1 } })
    process.env.MAX_RUN_COST_USD = '1'
    await runWithUsage(emptyUsage(), async () => {
      await expect(call(llm('{"ok":"bad"}', { input_tokens: 10, output_tokens: 10 }))).rejects.toThrow()
      expect(heldReservationUsd()).toBe(0)
    })
  })

  it.each([{ input: -1, output: 2 }, { input: 1 }, { input: 'free', output: 2 }])('rejects an invalid price entry %j', rate => {
    process.env.LLM_PRICES_JSON = JSON.stringify({ test: rate })
    process.env.MAX_RUN_COST_USD = '1'
    expect(() => estimateCallUsd({ provider: 'kimi', model: 'test', maxInputTokens: 10, maxOutputTokens: 10 })).toThrow(UnpricedModelError)
  })

  it('refuses a paid call when a budget is set and the model has no rate', async () => {
    process.env.MAX_RUN_COST_USD = '1'
    await runWithUsage(emptyUsage(), async () => {
      expect(() => estimateCallUsd({
        provider: 'kimi', model: 'kimi-k2.6', maxInputTokens: 100, maxOutputTokens: 100,
      })).toThrow(UnpricedModelError)
    })
  })

  it('holds the reservation when consumption is unknown', async () => {
    process.env.LLM_PRICES_JSON = JSON.stringify({ 'kimi-k2.6': { input: 1, output: 2 } })
    process.env.MAX_RUN_COST_USD = '1'
    const usage = emptyUsage()
    await runWithUsage(usage, async () => {
      const held = reserveRunCost({
        provider: 'kimi', model: 'kimi-k2.6', maxInputTokens: 100_000, maxOutputTokens: 50_000,
      })
      expect(held).toBeGreaterThan(0)
      expect(heldReservationUsd()).toBe(held)
      expect(() => reserveRunCost({
        provider: 'kimi', model: 'kimi-k2.6', maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000,
      })).toThrow(RunCostLimitError)
    })
  })
})
