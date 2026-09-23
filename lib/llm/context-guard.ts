import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'

type ContextAwareModel = {
  providerName?: string
  contextWindow?: number
  outputTokenReserve?: number
  countTextTokens?: (text: string) => number
}

function outputReserve(model: ContextAwareModel, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.ceil(override)
  }
  return model.outputTokenReserve ?? Math.max(1_024, Math.floor((model.contextWindow ?? 0) * 0.25))
}

function countedInputTokens(model: ContextAwareModel, messages: BaseMessage[]): number {
  if (!model.countTextTokens) return Math.ceil(messages.reduce((sum, message) => sum + contentLength(message), 0) / 4)
  // Content is tokenized using the installed vocabulary. Reserve additional
  // room for chat framing and provider-added prompt material.
  return 1024 + messages.reduce((sum, message) => sum + model.countTextTokens!(
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
  ), 0)
}

function contentLength(message: BaseMessage): number {
  if (typeof message.content === 'string') return message.content.length
  return JSON.stringify(message.content).length
}

function overflow(model: ContextAwareModel, inputTokens: number, reserve: number, base = false): Error {
  const error = new Error(
    base
      ? `${model.providerName ?? 'Model'} base prompt cannot fit: estimated ${inputTokens} input tokens + ${reserve} reserved output tokens exceed num_ctx=${model.contextWindow}.`
      : `${model.providerName ?? 'Model'} context is too small: estimated ${inputTokens} input tokens + ${reserve} reserved output tokens exceed num_ctx=${model.contextWindow}.`,
  )
  error.name = model.providerName === 'ollama' ? 'OllamaContextOverflowError' : 'ModelContextOverflowError'
  ;(error as Error & { code: string }).code = model.providerName === 'ollama' ? 'OLLAMA_CONTEXT_OVERFLOW' : 'MODEL_CONTEXT_OVERFLOW'
  return error
}

/** Conservative local-model guard: ~4 characters/token plus reserved output. */
export function assertModelContextFits(llm: unknown, messages: BaseMessage[], outputTokenReserve?: number): void {
  const model = llm as ContextAwareModel
  if (!model.contextWindow) return
  const estimatedInputTokens = countedInputTokens(model, messages)
  const reserve = outputReserve(model, outputTokenReserve)
  if (estimatedInputTokens + reserve <= model.contextWindow) return
  throw overflow(model, estimatedInputTokens, reserve)
}

/** Compact untrusted/evidence messages before a local call; never truncates the base system prompt. */
export function fitMessagesToModelContext(llm: unknown, messages: BaseMessage[], outputTokenReserve?: number): BaseMessage[] {
  const model = llm as ContextAwareModel
  if (!model.contextWindow) return messages
  const reserve = outputReserve(model, outputTokenReserve)
  if (model.countTextTokens) {
    const tokens = countedInputTokens(model, messages)
    if (tokens + reserve <= model.contextWindow) return messages
    throw overflow(model, tokens, reserve)
  }
  const availableCharacters = Math.max(0, (model.contextWindow - reserve) * 4)
  const systemCharacters = messages
    .filter((message) => message._getType() === 'system')
    .reduce((sum, message) => sum + contentLength(message), 0)
  if (systemCharacters > availableCharacters) {
    throw overflow(model, Math.ceil(systemCharacters / 4), reserve, true)
  }
  const totalCharacters = messages.reduce((sum, message) => sum + contentLength(message), 0)
  if (totalCharacters <= availableCharacters) return messages
  // Stable evidence references are meaningful only if their exact passages reach
  // the model. Head/tail compaction could remove a qualification or splice a quote.
  // Fail this call explicitly so normal phase fallback/recovery can handle it.
  if (messages.some(message => typeof message.content === 'string' && /\[(?:RAG-[a-f0-9]{24}|SRC-\d+)\]/.test(message.content))) {
    throw overflow(model, Math.ceil(totalCharacters / 4), reserve)
  }
  // Source-backed runs never permit silent compaction, including hosted models.
  if (model.providerName !== 'ollama') throw overflow(model, Math.ceil(totalCharacters / 4), reserve)
  const compactBudget = Math.max(0, availableCharacters - systemCharacters)
  const compactable = messages.filter((message) => message._getType() !== 'system')
  const eachBudget = Math.floor(compactBudget / Math.max(1, compactable.length))
  return messages.map((message) => {
    if (message._getType() === 'system') return message
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    if (text.length <= eachBudget) return message
    const marker = '\n\n[Evidence compacted to fit the configured Ollama num_ctx]\n\n'
    const usable = Math.max(0, eachBudget - marker.length)
    const head = Math.ceil(usable * 0.6)
    const compacted = `${text.slice(0, head)}${marker}${text.slice(-(usable - head))}`
    return message._getType() === 'human' ? new HumanMessage(compacted) : new SystemMessage(compacted)
  })
}
