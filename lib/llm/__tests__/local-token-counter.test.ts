import { afterEach, describe, expect, it, vi } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
import { createLocalTokenCounter, prepareLocalTokenCounters, type TokenCountedModel } from '../local-token-counter'
import { assertModelContextFits, fitMessagesToModelContext } from '../context-guard'
import { sourceNotesCharacterBudget } from '@/lib/architecture/source-evidence'

const info = {
  'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.pre': 'qwen2',
  'tokenizer.ggml.tokens': ['a', 'b', 'ab', 'Ġ', 'Ġab', '<|im_end|>'],
  'tokenizer.ggml.token_type': [1, 1, 1, 1, 1, 3],
  'tokenizer.ggml.merges': ['a b', 'Ġ ab'],
}
afterEach(() => vi.unstubAllGlobals())

describe('local token accounting', () => {
  it('does not contact Ollama or change token accounting for hosted providers', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const models = ['kimi', 'google', 'cursor', 'bedrock'].map(providerName => ({ providerName, model: 'provider-model' }))
    await prepareLocalTokenCounters(models, 'http://unused-ollama.invalid')
    expect(fetcher).not.toHaveBeenCalled()
    for (const model of models) expect(model).not.toHaveProperty('countTextTokens')
  })
  it('applies installed BPE merges, byte-level spaces and special tokens', () => {
    const count = createLocalTokenCounter(info)!
    expect(count('ab ab')).toBe(2)
    expect(count('ab<|im_end|>ab')).toBe(3)
  })

  it('uses the Qwen3.5 combining-mark boundary without changing Qwen2 behavior', () => {
    const marked = {
      'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.pre': 'qwen35',
      'tokenizer.ggml.tokens': ['a', 'Ì', 'ģ', 'aÌ', 'aÌģ'],
      'tokenizer.ggml.token_type': [1, 1, 1, 1, 1],
      'tokenizer.ggml.merges': ['a Ì', 'aÌ ģ'],
    }
    expect(createLocalTokenCounter(marked)!('a\u0301')).toBe(1)
    expect(createLocalTokenCounter({ ...marked, 'tokenizer.ggml.pre': 'qwen2' })!('a\u0301')).toBe(3)
  })

  it('does not assign a Qwen tokenizer to an unsupported or incomplete model', () => {
    expect(createLocalTokenCounter({ ...info, 'tokenizer.ggml.pre': 'llama3' })).toBeNull()
    expect(createLocalTokenCounter({ ...info, 'tokenizer.ggml.tokens': [] })).toBeNull()
  })

  it('shares metadata loading across model roles without sending source text', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ model_info: info }))
    vi.stubGlobal('fetch', fetcher)
    const first: TokenCountedModel & { providerName: string; model: string } = { providerName: 'ollama', model: 'test-qwen' }
    const second = { ...first }
    await prepareLocalTokenCounters([first, second], 'http://localhost:11434')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ model: 'test-qwen', verbose: true })
    expect(first.countTextTokens!('ab ab')).toBe(2)
    expect(second.countTextTokens).toBe(first.countTextTokens)
  })

  it('retains full messages when measured tokens fit despite a character estimate overflow', () => {
    const messages = [new HumanMessage(`[SRC-0001] ${'a'.repeat(16000)}`)]
    const model = { contextWindow: 4096, outputTokenReserve: 1024, countTextTokens: () => 1000 }
    expect(fitMessagesToModelContext(model, messages)).toBe(messages)
    expect(() => assertModelContextFits(model, messages)).not.toThrow()
  })

  it('budgets complete notes after measured input, reserved output and retrieval overhead', () => {
    const model = { contextWindow: 40960, outputTokenReserve: 8192, countTextTokens: (text: string) => Math.ceil(text.length / 4) }
    expect(sourceNotesCharacterBudget(model, 'a'.repeat(67000), 'system')).toBeGreaterThan(2000)
    expect(() => sourceNotesCharacterBudget({ ...model, contextWindow: 16384 }, 'a'.repeat(67000), 'system')).toThrow('insufficient room')
  })

  it('rejects token-dense messages that the character estimate would admit', () => {
    const messages = [new HumanMessage('字'.repeat(4000))]
    const model = { contextWindow: 4096, outputTokenReserve: 1024, countTextTokens: () => 4000 }
    expect(() => assertModelContextFits(model, messages)).toThrow('context is too small')
    expect(() => fitMessagesToModelContext(model, messages)).toThrow('context is too small')
  })
})
