import { describe, expect, it } from 'vitest'
import { elapsedRunSeconds, formatRuntime } from '@/lib/ui/format'

describe('elapsedRunSeconds', () => {
  const createdAt = '2026-09-17T12:00:00.000Z'
  const startedAt = '2026-09-17T12:00:10.000Z'
  const now = Date.parse('2026-09-17T12:08:10.000Z')

  it('counts in-flight elapsed time from startedAt once the clock is mounted', () => {
    expect(elapsedRunSeconds({
      status: 'running', durationSeconds: 0, startedAt, createdAt, now,
    })).toBe(480)
  })

  it('does not use Date.now during the first render', () => {
    expect(elapsedRunSeconds({
      status: 'running', durationSeconds: 0, startedAt, createdAt,
    })).toBeUndefined()
  })

  it('falls back to createdAt while the worker has not claimed the run', () => {
    expect(elapsedRunSeconds({
      status: 'pending', durationSeconds: null, startedAt: null, createdAt, now,
    })).toBe(490)
  })

  it('keeps the persisted duration for a finished run', () => {
    expect(elapsedRunSeconds({
      status: 'partial', durationSeconds: 1149, startedAt, createdAt, now,
    })).toBe(1149)
  })

  it('does not treat a missing finished duration as zero seconds', () => {
    expect(elapsedRunSeconds({
      status: 'completed', durationSeconds: null, startedAt, createdAt, now,
    })).toBeUndefined()
  })
})

describe('formatRuntime', () => {
  it('does not format nullish values as 0s', () => {
    expect(formatRuntime(Number.NaN)).toBe('–')
    expect(formatRuntime(42)).toBe('42s')
    expect(formatRuntime(125)).toBe('2m 05s')
  })
})
