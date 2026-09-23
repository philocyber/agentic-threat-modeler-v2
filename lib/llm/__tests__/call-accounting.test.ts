import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { emptyUsage, runWithUsage, estimateCost } from '../usage'
import { heldReservationUsd } from '../cost-reservation'
import { ModelCallAccounting, accountModelCall, runWithModelCallLimit } from '../call-accounting'
import { gatherEvidenceNotes } from '@/lib/agents/base'
import { invokeStructured } from '../structured'

afterEach(() => { vi.unstubAllEnvs() })

describe('model call accounting', () => {
  it('counts failed requests and responses without usage before allowing another request', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('network error')).mockResolvedValue({ content: 'ok' })
    const limit = { maxCalls: 2, started: 0 }
    await runWithModelCallLimit(limit, async () => {
      await expect(accountModelCall({}, 'Fixture', run)).rejects.toThrow('network')
      await accountModelCall({}, 'Fixture', run)
      await expect(accountModelCall({}, 'Fixture', run)).rejects.toMatchObject({ code: 'MODEL_CALL_LIMIT' })
    })
    expect(run).toHaveBeenCalledTimes(2)
    expect(limit.started).toBe(2)
  })

  it('applies one shared limit to prose and structured emissions', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: 'Evidence notes.' })
    const llm = { invoke } as unknown as BaseChatModel
    await runWithModelCallLimit({ maxCalls: 1, started: 0 }, async () => {
      await gatherEvidenceNotes({ llm, tools: [], systemPrompt: 'Summarize.', task: 'Fictional fixture.', agentName: 'Fixture' })
      await expect(invokeStructured({ llm, schema: z.object({ ok: z.boolean() }), systemPrompt: 'Return JSON.', userMessage: 'Fixture', agentName: 'Fixture' }))
        .rejects.toMatchObject({ code: 'MODEL_CALL_LIMIT' })
    })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('reserves prose calls and keeps unknown consumption against the next request', async () => {
    vi.stubEnv('MAX_RUN_COST_USD', '0.1')
    vi.stubEnv('LLM_PRICES_JSON', JSON.stringify({ fixture: { input: 1, output: 1 } }))
    const invoke = vi.fn().mockResolvedValue({ content: 'Evidence notes.' })
    const llm = { model: 'fixture', providerName: 'kimi', contextWindow: 60_000, outputTokenReserve: 1_000, invoke } as unknown as BaseChatModel
    await runWithUsage(emptyUsage(), async () => {
      await gatherEvidenceNotes({ llm, tools: [], systemPrompt: 'Summarize.', task: 'Fixture', agentName: 'Fixture' })
      expect(heldReservationUsd()).toBeCloseTo(0.061)
      await expect(gatherEvidenceNotes({ llm, tools: [], systemPrompt: 'Summarize.', task: 'Fixture', agentName: 'Fixture' }))
        .rejects.toMatchObject({ code: 'PIPELINE_COST_LIMIT' })
    })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('awaits the guard before a real LangChain model dispatch, including tool-loop callbacks', async () => {
    const llm = new FakeListChatModel({ responses: ['ok'] })
    const generate = vi.spyOn(llm, '_generate')
    const callbacks = [new ModelCallAccounting(llm, 'Fixture')]
    await runWithModelCallLimit({ maxCalls: 1, started: 0 }, async () => {
      await llm.invoke('fixture', { callbacks })
      await expect(llm.invoke('fixture', { callbacks })).rejects.toMatchObject({ code: 'MODEL_CALL_LIMIT' })
    })
    expect(generate).toHaveBeenCalledOnce()
  })

  it('records reported usage once and releases the reservation atomically', async () => {
    vi.stubEnv('MAX_RUN_COST_USD', '1')
    vi.stubEnv('LLM_PRICES_JSON', JSON.stringify({ fixture: { input: 1, output: 1 } }))
    const llm = { model: 'fixture', providerName: 'kimi', contextWindow: 1000, outputTokenReserve: 1000 }
    const usage = emptyUsage()
    await runWithUsage(usage, async () => {
      await accountModelCall(llm, 'Fixture', async () => ({ content: 'ok', usage_metadata: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }))
      expect(usage.calls).toBe(1)
      expect(estimateCost(usage).totalUsd).toBeCloseTo(0.00003)
      expect(heldReservationUsd()).toBe(0)
    })
  })
})
