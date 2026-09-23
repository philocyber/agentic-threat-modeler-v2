import { describe, expect, it } from 'vitest'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { fitMessagesToModelContext } from '../context-guard'

const ollama = { providerName: 'ollama', contextWindow: 2_048, outputTokenReserve: 1_024 }

describe('Ollama context guard', () => {
  it('never compacts a stable evidence passage into a different quotation', () => {
    const passage = '[RAG-0123456789abcdef01234567]\nEXACT PASSAGE:\n' + 'Evidence and its qualification. '.repeat(300)
    expect(() => fitMessagesToModelContext(ollama, [new SystemMessage('base'), new HumanMessage(passage)]))
      .toThrow(/context is too small/i)
    expect(fitMessagesToModelContext({ ...ollama, contextWindow: 16000 }, [new HumanMessage(passage)])[0]?.content).toBe(passage)
  })
  it('compacts evidence while preserving the complete base prompt', () => {
    const system = new SystemMessage('base instructions')
    const fitted = fitMessagesToModelContext(ollama, [system, new HumanMessage('evidence '.repeat(2_000))])
    expect(fitted[0]?.content).toBe('base instructions')
    expect(String(fitted[1]?.content)).toContain('Evidence compacted')
    expect(String(fitted[1]?.content).length).toBeLessThan(5_000)
  })

  it('fails clearly when the base prompt itself cannot fit', () => {
    expect(() => fitMessagesToModelContext(ollama, [new SystemMessage('x'.repeat(5_000))]))
      .toThrow(/base prompt cannot fit/i)
  })

  it('uses a schema-specific output reserve when the response is compact', () => {
    const cursor = {
      providerName: 'cursor',
      contextWindow: 32_768,
      outputTokenReserve: 16_384,
      countTextTokens: (text: string) => Math.ceil(text.length / 4),
    }
    const messages = [new HumanMessage('x'.repeat(68_000))]
    expect(() => fitMessagesToModelContext(cursor, messages)).toThrow(/16384 reserved output tokens/)
    expect(fitMessagesToModelContext(cursor, messages, 4_096)).toBe(messages)
  })
})
