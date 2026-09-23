export type TelemetryKind = 'log' | 'retry' | 'rag' | 'phase' | 'llm'

export type TelemetryLine = {
  at: number
  kind: TelemetryKind
  message: string
  severity: 'info' | 'warning' | 'error'
  class?: string
  durationMs?: number
  agent?: string
}

export type TelemetryPhaseRow = {
  phase: string
  status: 'start' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  durationMs?: number
  count?: number
  outputLabel?: string
  reused?: boolean
}

export type TelemetryHighlight = {
  kind: 'rate_limit' | 'rag_unavailable' | 'slow_phase' | 'retry'
  message: string
}

export type TelemetrySnapshot = {
  live: boolean
  rag?: {
    requested: boolean
    active: boolean
    reason?: string
  }
  phases: TelemetryPhaseRow[]
  highlights: TelemetryHighlight[]
  events: TelemetryLine[]
  totalEvents: number
  resume?: {
    from: string
    reusedPhases: number
    phaseNames: string[]
  }
}

const PHASE_OUTPUT_UNIT: Record<string, [string, string]> = {
  stride_analyst: ['threat', 'threats'],
  pasta_analyst: ['threat', 'threats'],
  attack_tree_analyst: ['threat', 'threats'],
  pre_dedup: ['candidate', 'candidates'],
  debate: ['round', 'rounds'],
  threat_synthesizer: ['threat', 'threats'],
  dread_validator: ['threat', 'threats'],
}

function phaseOutputLabel(phase: string, count: number | undefined): string | undefined {
  if (count === undefined) return undefined
  const unit = PHASE_OUTPUT_UNIT[phase]
  if (!unit) return String(count)
  return `${count} ${count === 1 ? unit[0] : unit[1]}`
}

const SLOW_PHASE_MS = 8 * 60_000

export function classifyTelemetryMessage(message: string, at = Date.now()): TelemetryLine {
  const agent = message.match(/^\[([^\]]+?)\s+\d{2}:\d{2}:\d{2}\]/)?.[1]
    ?? message.match(/^\[([^\]]+)\]/)?.[1]
  const durationMatch = message.match(/(?:after|in) ([\d.]+)s/)
  const durationMs = durationMatch ? Math.round(Number(durationMatch[1]) * 1000) : undefined
  const classMatch = message.match(/class=([a-z_]+)/i)?.[1]

  if (/RAG prefetch unavailable|RAG skipped|RAG disabled|RAG tools skipped/i.test(message)) {
    return {
      at,
      kind: 'rag',
      message,
      severity: 'warning',
      ...(agent ? { agent } : {}),
    }
  }
  if (/still running \(/i.test(message)) {
    return {
      at,
      kind: 'phase',
      message,
      severity: 'warning',
      ...(agent ? { agent } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    }
  }
  if (/Retrying |class=rate_limit|HTTP 429|engine is currently overloaded/i.test(message)) {
    return {
      at,
      kind: 'retry',
      message,
      severity: /failed|✗/.test(message) ? 'error' : 'warning',
      class: classMatch ?? 'rate_limit',
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(agent ? { agent } : {}),
    }
  }
  if (/failed after|analysis failed|✗ /i.test(message)) {
    return {
      at,
      kind: classMatch === 'rate_limit' ? 'retry' : 'log',
      message,
      severity: 'error',
      ...(classMatch ? { class: classMatch } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(agent ? { agent } : {}),
    }
  }
  if (/evidence notes gathered|LLM responded/i.test(message)) {
    return {
      at,
      kind: 'llm',
      message,
      severity: 'info',
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(agent ? { agent } : {}),
    }
  }
  return {
    at,
    kind: 'log',
    message,
    severity: 'info',
    ...(agent ? { agent } : {}),
  }
}

export function phaseRowsFromProgress(
  events: Array<{ phase: string; status: 'start' | 'done' | 'error'; timestamp: number; count?: number | undefined }>,
): TelemetryPhaseRow[] {
  const rows = new Map<string, TelemetryPhaseRow>()
  const ordered = [...events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    const rank = { start: 0, done: 1, error: 2 }
    return rank[a.status] - rank[b.status]
  })
  for (const event of ordered) {
    const existing = rows.get(event.phase)
    if (event.status === 'start') {
      if (existing && (existing.status === 'done' || existing.status === 'error')) continue
      rows.set(event.phase, {
        phase: event.phase,
        status: 'start',
        startedAt: event.timestamp,
        ...(event.count !== undefined ? { count: event.count } : {}),
      })
      continue
    }
    const startedAt = existing?.startedAt ?? event.timestamp
    rows.set(event.phase, {
      phase: event.phase,
      status: event.status,
      startedAt,
      endedAt: event.timestamp,
      durationMs: Math.max(0, event.timestamp - startedAt),
      ...(event.count !== undefined ? { count: event.count } : existing?.count !== undefined ? { count: existing.count } : {}),
    })
  }
  return [...rows.values()]
}

export function buildTelemetrySnapshot(input: {
  live: boolean
  progress: Array<{ phase: string; status: 'start' | 'done' | 'error'; timestamp: number; count?: number | undefined }>
  events: TelemetryLine[]
  rag?: TelemetrySnapshot['rag']
  resume?: TelemetrySnapshot['resume']
}): TelemetrySnapshot {
  const reused = new Set(input.resume?.phaseNames ?? [])
  const phases = phaseRowsFromProgress(input.progress).map((phase) => {
    const outputLabel = phaseOutputLabel(phase.phase, phase.count)
    return {
      ...phase,
      ...(outputLabel !== undefined ? { outputLabel } : {}),
      ...(reused.has(phase.phase) ? { reused: true } : {}),
    }
  })
  const highlights: TelemetryHighlight[] = []
  if (input.rag && !input.rag.active) {
    highlights.push({
      kind: 'rag_unavailable',
      message: input.rag.reason ?? 'Knowledge retrieval is not active for this run.',
    })
  }
  for (const event of input.events) {
    if (event.kind === 'retry' && event.class === 'rate_limit') {
      highlights.push({
        kind: 'rate_limit',
        message: event.message,
      })
    } else if (event.kind === 'rag') {
      if (!input.rag || input.rag.active) {
        highlights.push({
          kind: 'rag_unavailable',
          message: event.message,
        })
      }
    } else if (event.kind === 'retry') {
      highlights.push({
        kind: 'retry',
        message: event.message,
      })
    }
  }
  for (const phase of phases) {
    const duration = phase.durationMs
      ?? (phase.status === 'start' ? Date.now() - phase.startedAt : undefined)
    if (duration !== undefined && duration >= SLOW_PHASE_MS) {
      highlights.push({
        kind: 'slow_phase',
        message: phase.status === 'start'
          ? `${phase.phase} has been running for ${Math.round(duration / 1000)}s.`
          : `${phase.phase} took ${Math.round(duration / 1000)}s.`,
      })
    }
  }
  const seen = new Set<string>()
  const uniqueHighlights = highlights.filter((item) => {
    const key = `${item.kind}:${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 8)

  return {
    live: input.live,
    ...(input.rag ? { rag: input.rag } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    phases,
    highlights: uniqueHighlights,
    events: input.events.slice(-200),
    totalEvents: input.events.length,
  }
}
