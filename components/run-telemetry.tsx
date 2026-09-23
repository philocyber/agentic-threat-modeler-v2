'use client'

import { useEffect, useRef, useState } from 'react'
import { PHASE_LABEL } from '@/components/pipeline-steps'
import type { TelemetrySnapshot } from '@/lib/runs/telemetry'
import { formatDurationMs } from '@/lib/ui/format'

function formatDuration(ms: number | undefined, live: boolean): string {
  if (ms === undefined) return live ? 'in flight' : '—'
  return formatDurationMs(ms)
}

function highlightLabel(kind: TelemetrySnapshot['highlights'][number]['kind']): string {
  if (kind === 'rate_limit') return 'Provider 429'
  if (kind === 'rag_unavailable') return 'RAG'
  if (kind === 'slow_phase') return 'Slow phase'
  return 'Retry'
}

export function RunTelemetryWindow({
  analysisId,
  live,
  defaultExpanded = false,
}: {
  analysisId: string
  live: boolean
  defaultExpanded?: boolean
}) {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [clockNow, setClockNow] = useState(0)
  const [level, setLevel] = useState('all')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/v1/analysis/${encodeURIComponent(analysisId)}/telemetry`, {
          cache: 'no-store',
          credentials: 'include',
        })
        if (!res.ok) throw new Error(`Telemetry unavailable (${res.status})`)
        const body = (await res.json()) as TelemetrySnapshot
        if (!cancelled) {
          setSnapshot(body)
          setError('')
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Telemetry unavailable')
      }
    }
    void load()
    if (!live) return () => {
      cancelled = true
    }
    const id = window.setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [analysisId, expanded, live])

  useEffect(() => {
    if (!expanded) return
    const tick = () => setClockNow(Date.now())
    tick()
    const id = window.setInterval(tick, 5000)
    return () => window.clearInterval(id)
  }, [expanded])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [snapshot?.events.length])

  const running = live || Boolean(snapshot?.live)
  const phases = snapshot?.phases ?? []
  const highlights = snapshot?.highlights ?? []
  const events = snapshot?.events ?? []
  const visibleEvents = events.filter((event) => level === 'all' || event.severity === level)
    .map((event) => ({ ...event, isoTime: new Date(event.at).toISOString(), clockTime: new Date(event.at).toISOString().slice(11, 19) }))

  return (
    <details
      id="run-telemetry"
      open={defaultExpanded}
      className="group border-t border-[#e4e4e2] bg-[#fcfcfb]"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 marker:content-none">
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-[#cacac7] bg-white text-sm font-bold text-[#111111] transition-transform group-open:rotate-45" aria-hidden="true">+</span>
          <span className="min-w-0">
            <span id="run-telemetry-title" className="block text-sm font-semibold text-[#111111]">
              Telemetry and agent logs
            </span>
            <span className="mt-0.5 block truncate text-xs text-[#666666]">
              Phase timing, provider retries and operational details
            </span>
          </span>
        </span>
        <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[#666666]">
          {running ? 'Live' : 'Recorded'}
        </span>
      </summary>

      <div className="border-t border-[#e4e4e2] pt-4" aria-labelledby="run-telemetry-title">

      {error ? (
        <p className="px-5 pb-4 text-xs text-[#a11119]">{error}</p>
      ) : null}

      {snapshot?.rag ? (
        <p className="px-5 pb-3 text-xs leading-5 text-[#333333]">
          <strong>RAG:</strong>{' '}
          {snapshot.rag.active
            ? snapshot.rag.reason
              ? 'on, degraded'
              : 'on'
            : snapshot.rag.requested
              ? 'requested, skipped'
              : 'off'}
          {snapshot.rag.reason ? ` — ${snapshot.rag.reason}` : ''}
        </p>
      ) : null}

      {snapshot?.resume ? (
        <div className="mx-5 mb-4 border border-[#333333] bg-[#f1f1f0] px-3 py-2 text-xs leading-5 text-[#5f4300]">
          <strong>Checkpoint resume:</strong> {snapshot.resume.reusedPhases} phase{snapshot.resume.reusedPhases === 1 ? '' : 's'} restored from{' '}
          <a className="font-semibold underline underline-offset-2" href={`/results/${snapshot.resume.from}#run-telemetry`}>
            the prior attempt
          </a>
          . Rows marked “reused” show restore time, not the original model execution time.
        </div>
      ) : null}

      {highlights.length > 0 ? (
        <ul className="space-y-2 px-5 pb-4">
          {highlights.map((item) => (
            <li
              key={`${item.kind}:${item.message}`}
              className="border border-[#f5c19b] bg-[#fff4ec] px-3 py-2 text-xs leading-5 text-[#7c2d12]"
            >
              <span className="font-bold uppercase tracking-[0.08em]">{highlightLabel(item.kind)}</span>
              <span className="mt-1 block">{item.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {phases.length > 0 ? (
        <div className="overflow-x-auto px-5 pb-4">
          <table className="w-full text-left text-xs">
            <thead className="text-xs font-bold uppercase tracking-[0.08em] text-[#666666]">
              <tr>
                <th className="py-2 pr-3">Phase</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Duration</th>
                <th className="py-2">Output</th>
              </tr>
            </thead>
            <tbody>
              {phases.map((phase) => (
                <tr key={phase.phase} className="border-t border-[#eee8ea]">
                  <td className="py-2 pr-3 font-semibold text-[#333333]">
                    {PHASE_LABEL[phase.phase] ?? phase.phase}
                  </td>
                  <td className="py-2 pr-3 capitalize text-[#555555]">{phase.reused ? 'reused' : phase.status === 'start' ? 'running' : phase.status}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-[#333333]">
                    {phase.reused ? 'restore only' : formatDuration(
                      phase.durationMs ?? (phase.status === 'start' && clockNow > 0 ? clockNow - phase.startedAt : undefined),
                      phase.status === 'start',
                    )}
                  </td>
                  <td className="py-2 font-mono text-xs text-[#333333]">{phase.outputLabel ?? phase.count ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-5 pb-4 text-xs leading-5 text-[#666666]">
          {running
            ? 'Waiting for the first phase event…'
            : 'No live agent log was persisted for this run. Phase timing still comes from progress.jsonl when it exists.'}
        </p>
      )}

      {events.length > 0 ? (
        <div className="px-5 pb-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold uppercase tracking-[0.08em] text-[#666666]">Recorded events · {snapshot?.totalEvents ?? events.length}{(snapshot?.totalEvents ?? 0) > events.length ? ` (latest ${events.length} shown)` : ''}</p><div className="flex items-center gap-2"><label className="text-xs">Show <select aria-label="Filter log severity" value={level} onChange={(event) => setLevel(event.target.value)} className="border border-[#cacac7] bg-white px-2 py-1"><option value="all">all</option><option value="warning">warnings</option><option value="error">errors</option></select></label><a href={`/api/v1/analysis/${encodeURIComponent(analysisId)}/telemetry?format=jsonl`} download className="border border-[#cacac7] bg-white px-2 py-1 text-xs font-semibold">Download full log</a></div></div>
          <div
            ref={logRef}
            className="max-h-72 overflow-y-auto overscroll-contain border border-[#e4e4e2] bg-white p-3 font-mono text-xs leading-5 text-[#333333]"
          >
            {visibleEvents.map((event, index) => (
              <p
                key={`${event.at}:${index}`}
                className={
                  event.severity === 'error'
                    ? 'text-[#a11119]'
                    : event.severity === 'warning'
                      ? 'text-[#9a3412]'
                      : undefined
                }
              >
                <time className="mr-2 text-[#666666]" dateTime={event.isoTime}>{event.clockTime} UTC</time><span className="mr-2 uppercase">{event.severity}</span>{event.message}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      </div>
    </details>
  )
}
