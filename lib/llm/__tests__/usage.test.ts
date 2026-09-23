import { afterEach, describe, expect, it } from 'vitest'
import {
  assertRunCostBudget,
  emptyUsage,
  estimateCost,
  recordUsage,
  runWithUsage,
  RunCostLimitError,
} from '../usage'

afterEach(() => {
  delete process.env.LLM_PRICES_JSON
  delete process.env.MAX_RUN_COST_USD
})

describe('LLM usage and cost controls', () => {
  it('attributes provider, model and agent and prices cloud calls', async () => {
    process.env.LLM_PRICES_JSON = JSON.stringify({ cloud_model: { input: 1, output: 2 } })
    const usage = emptyUsage()
    await runWithUsage(usage, async () => {
      recordUsage(
        { usage_metadata: { input_tokens: 1_000_000, output_tokens: 500_000 } },
        'cloud_model',
        'StrideAnalyst',
        'kimi',
      )
    })
    expect(usage.byProviderModelAgent['kimi:cloud_model:StrideAnalyst'])
      .toMatchObject({ inputTokens: 1_000_000, outputTokens: 500_000, calls: 1 })
    expect(estimateCost(usage).totalUsd).toBe(2)
  })

  it('does not mistake a Bedrock model ID containing a colon for a local model', async () => {
    const usage = emptyUsage()
    await runWithUsage(usage, async () => {
      recordUsage({ usage_metadata: { input_tokens: 10, output_tokens: 5 } }, 'anthropic.model-v1:0', 'Judge', 'bedrock')
    })
    expect(estimateCost(usage).unpricedModels).toEqual(['anthropic.model-v1:0'])
  })

  it('aborts before the next call after the configured budget is reached', async () => {
    process.env.LLM_PRICES_JSON = JSON.stringify({ model: { input: 1, output: 1 } })
    process.env.MAX_RUN_COST_USD = '0.00001'
    const usage = emptyUsage()
    await runWithUsage(usage, async () => {
      recordUsage({ usage_metadata: { input_tokens: 10, output_tokens: 10 } }, 'model', 'Agent', 'google')
      expect(() => assertRunCostBudget()).toThrow(RunCostLimitError)
    })
  })
})
