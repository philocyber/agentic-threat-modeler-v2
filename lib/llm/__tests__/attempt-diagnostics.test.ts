import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { invokeStructured } from '../structured'
import { MAX_REJECTED_RESPONSE_CHARS, sanitizeRejectedResponse, runWithAttemptSink, type AttemptDiagnostic } from '../attempt-diagnostics'

describe('structured attempt diagnostics', () => {
  it('keeps a typical multi-entry rejected response parseable for offline replay', () => {
    const raw = JSON.stringify({ findings: Array.from({ length: 10 }, (_, i) => ({ id: i, text: 'context '.repeat(300) })) })
    expect(raw.length).toBeGreaterThan(8192)
    const saved = sanitizeRejectedResponse(raw)
    expect(saved.truncated).toBe(false)
    expect(JSON.parse(saved.text).findings).toHaveLength(10)
  })

  it('preserves usage and reports truncation of a long rejected response accurately', async () => {
    const raw = `malformed response ${'x'.repeat(MAX_REJECTED_RESPONSE_CHARS + 1000)}`
    const llm = { model: 'fixture', invoke: async () => ({
      content: raw, usage_metadata: { input_tokens: 10, output_tokens: 20 },
      response_metadata: { load_duration: 2e6, prompt_eval_duration: 3e6, eval_duration: 4e6 },
    }) } as unknown as BaseChatModel
    const records: Array<{ diagnostic: AttemptDiagnostic; rejected?: string }> = []
    await runWithAttemptSink({ runId: 'fixture', record: async (diagnostic, rejected) => { records.push({ diagnostic, ...(rejected ? { rejected } : {}) }) } }, async () => {
      await expect(invokeStructured({ llm, schema: z.object({ ok: z.boolean() }), systemPrompt: 'Return JSON.', userMessage: 'Fixture', agentName: 'Fixture' })).rejects.toThrow()
    })
    expect(records).toHaveLength(1)
    expect(records[0]?.diagnostic).toMatchObject({ inputTokens: 10, outputTokens: 20, loadMs: 2, processingMs: 3, generationMs: 4, rejectedResponseTruncated: true, rejectedResponseChars: raw.length })
    expect(records[0]?.rejected).toContain('[truncated after')
  })
})
