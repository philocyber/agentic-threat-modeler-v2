import { describe, expect, it } from 'vitest'
import {
  buildTelemetrySnapshot,
  classifyTelemetryMessage,
  phaseRowsFromProgress,
} from '@/lib/runs/telemetry'

describe('classifyTelemetryMessage', () => {
  it('flags in-flight phase watchdog lines', () => {
    const line = classifyTelemetryMessage(
      '[pipeline] pasta_analyst still running (120s) — waiting on the provider',
      3,
    )
    expect(line).toMatchObject({ kind: 'phase', severity: 'warning' })
  })

  it('flags provider 429 retries with duration', () => {
    const line = classifyTelemetryMessage(
      '[AttackTreeAnalyst 19:58:09] ✗ evidence phase failed after 122.0s (attempt 1/2, class=rate_limit): The engine is currently overloaded',
      2,
    )
    expect(line.kind).toBe('retry')
    expect(line.class).toBe('rate_limit')
    expect(line.durationMs).toBe(122_000)
    expect(line.severity).toBe('error')
  })
})

describe('phaseRowsFromProgress', () => {
  it('does not let a same-timestamp start reopen a completed phase', () => {
    const rows = phaseRowsFromProgress([
      { phase: 'architecture_parser', status: 'done', timestamp: 5_000 },
      { phase: 'architecture_parser', status: 'start', timestamp: 5_000 },
      { phase: 'stride_analyst', status: 'start', timestamp: 5_001 },
      { phase: 'stride_analyst', status: 'done', timestamp: 5_001, count: 4 },
    ])
    expect(rows.find((row) => row.phase === 'architecture_parser')?.status).toBe('done')
    expect(rows.find((row) => row.phase === 'stride_analyst')?.status).toBe('done')
  })
})

describe('buildTelemetrySnapshot', () => {
  it('retains event count and labels a completed slow phase as elapsed time', () => {
    const repeated = classifyTelemetryMessage('[pipeline] provider retry', 1)
    const snapshot = buildTelemetrySnapshot({
      live: false,
      progress: [
        { phase: 'debate', status: 'start', timestamp: 1 },
        { phase: 'debate', status: 'done', timestamp: 9 * 60_000 + 1 },
      ],
      events: [repeated, repeated],
    })
    expect(snapshot.totalEvents).toBe(2)
    expect(snapshot.events).toHaveLength(2)
    expect(snapshot.highlights).toContainEqual({ kind: 'slow_phase', message: 'debate took 540s.' })
  })

  it('surfaces RAG skip and rate-limit highlights', () => {
    const snapshot = buildTelemetrySnapshot({
      live: true,
      progress: [{ phase: 'pasta_analyst', status: 'start', timestamp: Date.now() - 9 * 60_000 }],
      events: [
        classifyTelemetryMessage('[pipeline] RAG skipped: Chroma is not running at http://localhost:8000.'),
        classifyTelemetryMessage('[AttackTreeAnalyst] ✗ evidence phase failed after 122.0s (attempt 1/2, class=rate_limit): overloaded'),
      ],
      rag: { requested: true, active: false, reason: 'Chroma is not running' },
    })
    expect(snapshot.highlights.some((item) => item.kind === 'rag_unavailable')).toBe(true)
    expect(snapshot.highlights.some((item) => item.kind === 'rate_limit')).toBe(true)
    expect(snapshot.highlights.some((item) => item.kind === 'slow_phase')).toBe(true)
  })

  it('labels restored phase timing and phase-specific output units', () => {
    const snapshot = buildTelemetrySnapshot({
      live: false,
      progress: [
        { phase: 'pre_dedup', status: 'start', timestamp: 1 },
        { phase: 'pre_dedup', status: 'done', timestamp: 2, count: 12 },
        { phase: 'debate', status: 'start', timestamp: 2 },
        { phase: 'debate', status: 'done', timestamp: 2, count: 1 },
      ],
      events: [],
      resume: { from: 'tm_source', reusedPhases: 2, phaseNames: ['pre_dedup', 'debate'] },
    })
    expect(snapshot.phases[0]).toMatchObject({ reused: true, outputLabel: '12 candidates' })
    expect(snapshot.phases[1]).toMatchObject({ reused: true, outputLabel: '1 round' })
  })
})
