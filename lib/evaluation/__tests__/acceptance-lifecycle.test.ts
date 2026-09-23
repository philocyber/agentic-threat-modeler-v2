import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AcceptanceDeadlineError,
  acceptanceDiagnostic,
  runAcceptanceAttempt,
  runWithAcceptanceDeadline,
  withResponseCacheDisabled,
  writeAcceptanceReport,
} from '../acceptance-lifecycle'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('acceptance lifecycle', () => {
  it('uses one deadline and abort signal for an entire attempt', async () => {
    const seen: AbortSignal[] = []
    await expect(runWithAcceptanceDeadline({
      timeoutMs: 20,
      run: async (signal) => {
        seen.push(signal)
        await new Promise((resolve) => setTimeout(resolve, 100))
        return 'unreachable'
      },
    })).rejects.toBeInstanceOf(AcceptanceDeadlineError)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
  })

  it('returns a timed out result with a bounded diagnostic', async () => {
    const result = await runAcceptanceAttempt({
      timeoutMs: 15,
      run: async (signal) => new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => resolve('aborted'), { once: true })
      }),
    })
    expect(result.status).toBe('timed_out')
    expect(result.error?.name).toBe('AcceptanceDeadlineError')
    expect(result.error?.message.length).toBeLessThan(2_001)
  })

  it('disables and clears response caching for each probe', async () => {
    const previous = process.env.LLM_RESPONSE_CACHE_ENABLED
    process.env.LLM_RESPONSE_CACHE_ENABLED = 'true'
    try {
      await withResponseCacheDisabled(async () => {
        expect(process.env.LLM_RESPONSE_CACHE_ENABLED).toBe('0')
      })
      expect(process.env.LLM_RESPONSE_CACHE_ENABLED).toBe('true')
    } finally {
      if (previous === undefined) delete process.env.LLM_RESPONSE_CACHE_ENABLED
      else process.env.LLM_RESPONSE_CACHE_ENABLED = previous
    }
  })

  it('persists bounded reports without exposing secret-shaped diagnostics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'acceptance-lifecycle-'))
    temporaryDirectories.push(directory)
    const output = join(directory, 'report.json')
    await writeAcceptanceReport(output, {
      stage: 3,
      scope: 'debate-only',
      status: 'failed',
      passed: false,
      safe: acceptanceDiagnostic(new Error('provider token=super-secret')).message,
      error: acceptanceDiagnostic(new Error(`provider token=super-secret ${'x'.repeat(300_000)}`)),
      huge: 'y'.repeat(400_000),
    }, 8_192)
    const report = await readFile(output, 'utf8')
    expect(Buffer.byteLength(report)).toBeLessThanOrEqual(8_192)
    expect(report).not.toContain('super-secret')
    expect(report).toContain('[REDACTED]')
  })

  it('omits oversized URI diagnostics rather than leaking a cut credential', () => {
    const diagnostic = acceptanceDiagnostic(new Error(`https://user:${'p'.repeat(20_000)}@internal.example ${'x'.repeat(20_000)}`))
    expect(diagnostic.message).toMatch(/^\[truncated \d+ chars\]$/)
    expect(diagnostic.message).not.toContain('internal.example')
  })
})
