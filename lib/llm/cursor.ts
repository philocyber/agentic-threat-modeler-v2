/**
 * LangChain chat adapter over the Cursor SDK.
 *
 * Cursor is an agent runtime, not a chat-completions API. Each invoke is a
 * one-shot `Agent.prompt` with `tools: []` (text only) and an isolated empty
 * cwd so the threat-model graph never gets shell or workspace tools (ASI-01).
 */

import { SimpleChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage, type StandardMessageStructure } from '@langchain/core/messages'
import type { ChatResult } from '@langchain/core/outputs'
import { Agent, CursorAgentError, type ModelSelection, type RunResult } from '@cursor/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CURSOR_MODEL = 'grok-4.7'

const JSON_INSTRUCTION =
  '\n\nRespond with a single JSON object or array only. No markdown fences, no tool use, no extra prose.'

export type CursorPromptFn = (
  message: string,
  options: Parameters<typeof Agent.prompt>[1]
) => Promise<RunResult>

let promptImpl: CursorPromptFn = (message, options) => Agent.prompt(message, options)

/** Test seam — restore with `undefined` to use the real SDK. */
export function setCursorPromptImpl(fn: CursorPromptFn | undefined): void {
  promptImpl = fn ?? ((message, options) => Agent.prompt(message, options))
}

export function buildCursorModelSelection(modelId: string, useFast: boolean): ModelSelection {
  if (useFast) {
    return { id: modelId, params: [{ id: 'fast', value: 'true' }] }
  }
  return { id: modelId }
}

function contentToText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function messagesToPrompt(messages: BaseMessage[], jsonMode: boolean): string {
  const body = messages
    .map((msg) => {
      const role = msg._getType()
      const label = role === 'system' ? 'System' : role === 'ai' ? 'Assistant' : 'User'
      return `${label}:\n${contentToText(msg.content)}`
    })
    .join('\n\n')
  return jsonMode ? `${body}${JSON_INSTRUCTION}` : body
}

function abortError(): Error {
  const err = new Error('Stopped by user')
  err.name = 'AbortError'
  return err
}

async function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) throw abortError()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

export class ChatCursorGrok extends SimpleChatModel {
  readonly apiKey: string
  readonly modelId: string
  readonly model: string
  readonly useFast: boolean
  readonly jsonMode: boolean

  constructor(fields: {
    apiKey: string
    model: string
    useFast?: boolean
    jsonMode?: boolean
  }) {
    super({})
    this.apiKey = fields.apiKey
    this.modelId = fields.model
    this.model = fields.model
    this.useFast = fields.useFast ?? false
    this.jsonMode = fields.jsonMode ?? false
  }

  _llmType(): string {
    return 'cursor-grok'
  }

  private async execute(
    messages: BaseMessage[],
    options: this['ParsedCallOptions']
  ): Promise<{ text: string; result: RunResult }> {
    const cwd = await mkdtemp(join(tmpdir(), 'agentictm-cursor-'))
    try {
      const result = await raceWithSignal(
        promptImpl(messagesToPrompt(messages, this.jsonMode), {
          apiKey: this.apiKey,
          model: buildCursorModelSelection(this.modelId, this.useFast),
          tools: [],
          local: { cwd, settingSources: [] },
        }),
        options.signal
      )

      if (result.status === 'error') {
        throw new Error(
          result.error?.message ?? `Cursor run failed (${result.id})`
        )
      }
      if (result.status === 'cancelled') {
        throw abortError()
      }

      const text = result.result?.trim() ?? ''
      if (!text) {
        throw new Error('Cursor agent returned empty text')
      }
      return { text, result }
    } catch (err) {
      if (err instanceof CursorAgentError) {
        const wrapped = new Error(`Cursor SDK: ${err.message}`)
        wrapped.name = err.isRetryable ? 'RetryableError' : 'CursorAgentError'
        throw wrapped
      }
      throw err
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
  }

  async _call(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<string> {
    return (await this.execute(messages, options)).text
  }

  override async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const { text, result } = await this.execute(messages, options)
    const usage = result.usage
    const message = new AIMessage<StandardMessageStructure>(text)
    if (usage) {
      message.usage_metadata = {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
        input_token_details: {
          cache_read: usage.cacheReadTokens,
          cache_creation: usage.cacheWriteTokens,
        },
        output_token_details: { reasoning: usage.reasoningTokens ?? 0 },
      }
    }
    message.response_metadata = {
      provider: 'cursor',
      runId: result.id,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(result.model ? { model: result.model } : {}),
    }
    return {
      generations: [{ text, message }],
      llmOutput: { provider: 'cursor', runId: result.id, durationMs: result.durationMs },
    }
  }
}
