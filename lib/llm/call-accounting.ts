import { AsyncLocalStorage } from 'node:async_hooks'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { LLMResult } from '@langchain/core/outputs'
import { reserveRunCost, settleRunCostReservation } from './cost-reservation'
import { assertRunCostBudget, modelNameOf, providerNameOf, recordUsage } from './usage'

type CallLimit = { maxCalls: number; started: number }
const callLimits = new AsyncLocalStorage<CallLimit>()

export class ModelCallLimitError extends Error {
  readonly code = 'MODEL_CALL_LIMIT'
  constructor(limit: number) {
    super(`The limit of ${limit} model calls was reached. No further request was sent.`)
    this.name = 'ModelCallLimitError'
  }
}

export function runWithModelCallLimit<T>(limit: CallLimit, run: () => Promise<T>): Promise<T> {
  if (!Number.isInteger(limit.maxCalls) || limit.maxCalls < 1) throw new Error('Invalid model call limit')
  return callLimits.run(limit, run)
}

/** Reserve before dispatch, for prose, schema emission, and each tool-loop call. */
function beginCall(llm: unknown, agent: string): (message: unknown) => void {
  assertRunCostBudget()
  const limit = callLimits.getStore()
  if (limit && limit.started >= limit.maxCalls) throw new ModelCallLimitError(limit.maxCalls)
  const capacity = llm as { contextWindow?: number; outputTokenReserve?: number }
  const model = modelNameOf(llm)
  const provider = providerNameOf(llm)
  const held = reserveRunCost({
    provider, model: model ?? 'unknown',
    maxInputTokens: capacity.contextWindow ?? 0,
    maxOutputTokens: capacity.outputTokenReserve ?? 4_096,
  })
  if (limit) limit.started += 1
  let settled = false
  return message => {
    if (settled) return
    settled = true
    recordUsage(message, model, agent, provider)
    const metadata = (message as { usage_metadata?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage_metadata
    // A valid JSON response does not imply known consumption. Preserve the hold
    // for missing or incomplete usage, including successful provider responses.
    if ([metadata?.input_tokens, metadata?.output_tokens].every(value => (
      typeof value === 'number' && Number.isFinite(value) && value >= 0
    ))) settleRunCostReservation(held)
  }
}

export async function accountModelCall<T>(
  llm: unknown,
  agent: string,
  run: () => Promise<T>,
  message: (result: T) => unknown = result => result,
): Promise<T> {
  const finish = beginCall(llm, agent)
  const result = await run()
  finish(message(result))
  return result
}

/** Awaited callbacks meter individual model requests inside a LangGraph tool loop. */
export class ModelCallAccounting extends BaseCallbackHandler {
  name = 'model-call-accounting'
  private readonly pending = new Map<string, (message: unknown) => void>()
  constructor(private readonly llm: unknown, private readonly agent: string) {
    super({ _awaitHandler: true, raiseError: true })
  }
  override handleChatModelStart(_llm: unknown, _messages: unknown, runId: string): void {
    this.pending.set(runId, beginCall(this.llm, this.agent))
  }
  override handleLLMEnd(output: LLMResult, runId: string): void {
    const finish = this.pending.get(runId)
    this.pending.delete(runId)
    const generation = output.generations[0]?.[0]
    finish?.(generation && 'message' in generation ? generation.message : undefined)
  }
  override handleLLMError(_error: unknown, runId: string): void {
    // No provider usage was returned. Keep the reservation for possible charges.
    this.pending.delete(runId)
  }
}
