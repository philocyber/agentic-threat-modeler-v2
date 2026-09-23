import { afterEach, describe, expect, it, vi } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
import { CursorAgentError } from '@cursor/sdk'
import {
  ChatCursorGrok,
  buildCursorModelSelection,
  setCursorPromptImpl,
} from '@/lib/llm/cursor'

describe('buildCursorModelSelection', () => {
  it('omits Fast params for the deep tier', () => {
    expect(buildCursorModelSelection('grok-4.7', false)).toEqual({ id: 'grok-4.7' })
  })

  it('adds Fast params for the quick tier', () => {
    expect(buildCursorModelSelection('grok-4.7', true)).toEqual({
      id: 'grok-4.7',
      params: [{ id: 'fast', value: 'true' }],
    })
  })
})

describe('ChatCursorGrok', () => {
  afterEach(() => setCursorPromptImpl(undefined))

  it('invokes a text-only Agent.prompt in an isolated cwd', async () => {
    const prompt = vi.fn(async (_message: string, options) => {
      expect(options?.tools).toEqual([])
      expect(options?.local?.settingSources).toEqual([])
      expect(options?.local?.cwd).toMatch(/agentictm-cursor-/)
      expect(options?.apiKey).toBe('cursor_test')
      expect(options?.model).toEqual({
        id: 'grok-4.7',
        params: [{ id: 'fast', value: 'true' }],
      })
      return {
        id: 'run-1',
        requestId: 'request-1',
        status: 'finished' as const,
        result: '{"ok":true}',
        durationMs: 25,
        model: { id: 'grok-4.7' },
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          totalTokens: 18,
          reasoningTokens: 4,
        },
      }
    })
    setCursorPromptImpl(prompt)

    const llm = new ChatCursorGrok({
      apiKey: 'cursor_test',
      model: 'grok-4.7',
      useFast: true,
      jsonMode: true,
    })
    const out = await llm.invoke([new HumanMessage('hello')])
    expect(String(out.content)).toContain('ok')
    expect(out.usage_metadata).toMatchObject({
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_token_details: { cache_read: 3, cache_creation: 2 },
      output_token_details: { reasoning: 4 },
    })
    expect(out.response_metadata).toMatchObject({
      provider: 'cursor', runId: 'run-1', requestId: 'request-1', durationMs: 25,
    })
    expect(prompt).toHaveBeenCalledTimes(1)
    const message = prompt.mock.calls[0]![0]
    expect(message).toContain('JSON')
    expect(message).toContain('hello')
  })

  it('treats result.status error as a thrown failure', async () => {
    setCursorPromptImpl(async () => ({
      id: 'run-err',
      status: 'error' as const,
      error: { message: 'mid-flight failure' },
    }))
    const llm = new ChatCursorGrok({ apiKey: 'k', model: 'grok-4.7' })
    await expect(llm.invoke([new HumanMessage('x')])).rejects.toThrow('mid-flight failure')
  })

  it('rejects empty assistant text', async () => {
    setCursorPromptImpl(async () => ({
      id: 'run-empty',
      status: 'finished' as const,
      result: '   ',
    }))
    const llm = new ChatCursorGrok({ apiKey: 'k', model: 'grok-4.7' })
    await expect(llm.invoke([new HumanMessage('x')])).rejects.toThrow('empty text')
  })

  it('maps CursorAgentError into a retryable wrapper when the SDK says so', async () => {
    setCursorPromptImpl(async () => {
      throw new CursorAgentError('never started', { isRetryable: true })
    })
    const llm = new ChatCursorGrok({ apiKey: 'k', model: 'grok-4.7' })
    await expect(llm.invoke([new HumanMessage('x')])).rejects.toMatchObject({
      name: 'RetryableError',
      message: expect.stringContaining('never started'),
    })
  })
})
