'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { isTerminalAnalysisStatus } from '@/lib/models/analysis-status'
import { LiveScanFlightboard } from '@/components/live-scan-flightboard'
import { PendingRunNotice } from '@/components/pending-run-notice'
import { mergeProgressEvents } from '@/lib/runs/progress-events'
import { derivePhases } from '@/lib/ui/progress-phases'
import type { AnalysisConfig } from '@/lib/models/types'

type ProgressEvent = { phase: string; status: 'start' | 'done' | 'error'; count?: number | undefined; timestamp: number }

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function AnalysisProgress({ analysisId, systemName, enabledAnalysts, completionHref }: {
  analysisId: string
  systemName?: string | undefined
  enabledAnalysts?: AnalysisConfig['enabledAnalysts'] | undefined
  completionHref?: string
}) {
  const router = useRouter()
  const terminalNavigationStarted = useRef(false)
  const showResults = useCallback(() => {
    if (!completionHref) {
      router.refresh()
    } else if (!terminalNavigationStarted.current) {
      terminalNavigationStarted.current = true
      router.replace(completionHref)
    }
  }, [completionHref, router])
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const [finalStatus, setFinalStatus] = useState<string>('running')
  const [errorMessage, setErrorMessage] = useState<string>()
  const [elapsed, setElapsed] = useState(0)
  const [stopping, setStopping] = useState(false)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [startTime, setStartTime] = useState<number | null>(null)
  const [initialized, setInitialized] = useState(false)

  // Load initial state from API (for when navigating from listing)
  useEffect(() => {
    if (initialized) return
    
    async function loadInitialState() {
      try {
        const res = await fetch(`/api/v1/analysis/${analysisId}/status`, {
          credentials: 'include',
        })
        if (!res.ok) return
        
        const data = await res.json() as {
          analysis_id: string
          status: string
          progress?: {
            current_phase?: string
            events?: ProgressEvent[]
            phases_completed: string[]
            phases_failed?: string[]
            phases_remaining: string[]
            percentage: number
          }
          started_at?: string
          completed_at?: string
          error_message?: string
        }

        // Set real start time from DB
        if (data.started_at) {
          setStartTime(new Date(data.started_at).getTime())
        }

        // Reconstruct events from completed phases
        if (data.progress) {
          const initialEvents: ProgressEvent[] = []
          const now = Date.now()
          
          // Add 'done' events for completed phases
          data.progress.phases_completed.forEach((phase, index) => {
            initialEvents.push({
              phase,
              status: 'done',
              timestamp: now - (data.progress!.phases_completed.length - index) * 1000,
            })
          })

          data.progress.phases_failed?.forEach((phase, index) => {
            initialEvents.push({
              phase,
              status: 'error',
              timestamp: now - (data.progress!.phases_failed!.length - index) * 1000,
            })
          })
          
          // Add 'start' event for current phase
          if (data.progress.current_phase) {
            initialEvents.push({
              phase: data.progress.current_phase,
              status: 'start',
              timestamp: now,
            })
          }
          
          setEvents(data.progress.events?.length ? data.progress.events : initialEvents)
        }

        setFinalStatus(data.status)
        if (data.error_message) setErrorMessage(data.error_message)
        if (isTerminalAnalysisStatus(data.status)) showResults()
        
      } catch (err) {
        console.error('Failed to load initial progress state:', err)
      } finally {
        setInitialized(true)
      }
    }

    loadInitialState()
  }, [analysisId, initialized, showResults])

  // Update elapsed time
  useEffect(() => {
    if (isTerminalAnalysisStatus(finalStatus) || !startTime) return
    const id = setInterval(() => setElapsed(Date.now() - startTime), 1000)
    return () => clearInterval(id)
  }, [finalStatus, startTime])

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/analysis/${analysisId}/status`, {
        credentials: 'include',
      })
      if (!res.ok) return false
      const data = await res.json() as {
        analysis_id: string
        status: string
        progress?: {
          current_phase?: string
          events?: ProgressEvent[]
            phases_completed: string[]
          phases_failed?: string[]
          phases_remaining: string[]
          percentage: number
        }
        started_at?: string
        completed_at?: string
        error_message?: string
      }

      if (data.progress) {
        const now = Date.now()
        setEvents((prev) => {
          if (data.progress?.events?.length) return mergeProgressEvents(prev, data.progress.events)
          const existing = new Set(prev.filter((e) => e.status === 'done').map((e) => e.phase))
          const existingFailures = new Set(prev.filter((e) => e.status === 'error').map((e) => e.phase))
          const additions: ProgressEvent[] = []
          for (const phase of data.progress?.phases_completed ?? []) {
            if (!existing.has(phase)) {
              additions.push({ phase, status: 'done', timestamp: now })
            }
          }
          for (const phase of data.progress?.phases_failed ?? []) {
            if (!existingFailures.has(phase)) {
              additions.push({ phase, status: 'error', timestamp: now })
            }
          }
          if (data.progress?.current_phase && !prev.some((e) => e.phase === data.progress!.current_phase && e.status === 'start')) {
            additions.push({ phase: data.progress.current_phase, status: 'start', timestamp: now })
          }
          return additions.length ? [...prev, ...additions] : prev
        })
      }

      setFinalStatus(data.status)
      if (data.error_message) setErrorMessage(data.error_message)
      if (isTerminalAnalysisStatus(data.status)) {
        showResults()
        return true
      }
      return false
    } catch {
      return false
    }
  }, [analysisId, showResults])

  // A run is live until it reaches a terminal state. Gating this on
  // `=== 'running'` deadlocked the page on a freshly queued analysis: the run
  // starts as `pending`, the effect bailed out, and the only thing that could
  // have advanced the status was the poll this effect owns — so the page sat
  // frozen until a manual reload.
  useEffect(() => {
    if (isTerminalAnalysisStatus(finalStatus) || !initialized) return

    let disposed = false
    let eventSource: EventSource | null = null
    let pollInterval: ReturnType<typeof setInterval> | null = null
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempts = 0

    function clearPoll() {
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
    }

    /**
     * Runs for the whole life of the run, not only when the stream breaks.
     * Progress events live in the server process's memory, so a dev recompile
     * or a restart silently orphans them and the stream goes quiet while the
     * pipeline keeps going — that is the "0/8 for 15 minutes" freeze. The
     * status endpoint reads the phases persisted on disk, so polling it keeps
     * the page truthful no matter what happened to the emitter.
     */
    function startPolling() {
      if (pollInterval) return
      pollInterval = setInterval(async () => {
        const finished = await pollStatus()
        if (finished) clearPoll()
      }, 3000)
    }

    function connect() {
      if (disposed) return
      setReconnecting(false)

      eventSource = new EventSource(`/api/v1/analysis/${analysisId}/stream`, {
        withCredentials: true,
      })
      eventSource.onopen = () => {
        reconnectAttempts = 0
        setReconnecting(false)
      }

      eventSource.addEventListener('progress', (e) => {
        try {
          const data = JSON.parse(e.data) as ProgressEvent
          // Reconnects replay persisted events; keep one state per phase.
          setEvents((prev) => mergeProgressEvents(prev, [data]))
        } catch { /* ignore */ }
      })

      eventSource.addEventListener('complete', (e) => {
        let status = 'completed'
        if (e instanceof MessageEvent && e.data) {
          try {
            status = (JSON.parse(e.data) as { status?: string }).status ?? 'completed'
          } catch { /* keep the default */ }
        }
        setFinalStatus(status)
        eventSource?.close()
        clearPoll()
        showResults()
      })

      eventSource.addEventListener('error', (e) => {
        if (e instanceof MessageEvent && e.data) {
          try {
            const data = JSON.parse(e.data) as { message?: string }
            if (data.message) setErrorMessage(data.message)
          } catch { /* ignore */ }
        }
        setFinalStatus('failed')
        eventSource?.close()
        clearPoll()
        showResults()
      })

      eventSource.addEventListener('status', (e) => {
        try {
          const data = JSON.parse(e.data) as { status: string; error_message?: string }
          setFinalStatus(data.status)
          if (data.error_message) setErrorMessage(data.error_message)
          if (isTerminalAnalysisStatus(data.status)) {
            eventSource?.close()
            clearPoll()
            showResults()
          }
        } catch { /* ignore */ }
      })

      eventSource.onerror = () => {
        eventSource?.close()
        eventSource = null
        if (disposed) return
        if (reconnectAttempts >= 5) {
          setReconnecting(false)
          return
        }
        setReconnecting(true)
        const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempts)
        reconnectAttempts += 1
        reconnectTimeout = setTimeout(connect, delay)
      }
    }

    startPolling()
    connect()

    return () => {
      disposed = true
      eventSource?.close()
      clearPoll()
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
    }
  }, [analysisId, finalStatus, initialized, pollStatus, showResults])

  async function handleStop() {
    setStopping(true)
    try {
      await fetch(`/api/v1/results/${analysisId}/stop`, {
        method: 'POST',
        credentials: 'include',
      })
      setShowStopConfirm(false)
      router.refresh()
    } finally {
      setStopping(false)
    }
  }

  const phases = derivePhases(events, enabledAnalysts)

  return (
    <div className="space-y-3">
      {finalStatus === 'pending' && <PendingRunNotice />}
      <LiveScanFlightboard
        systemName={systemName}
        phases={phases}
        events={events}
        enabledAnalysts={enabledAnalysts}
        elapsedLabel={formatElapsed(elapsed)}
        statusLabel={finalStatus === 'pending' ? 'Analysis queued' : 'Analysis in progress'}
        reconnecting={reconnecting}
        actions={showStopConfirm ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-red-700">Stop analysis?</span>
            <button
              type="button"
              className="min-h-9 border border-red-400 bg-red-600 px-3 text-xs font-semibold text-white hover:bg-red-700"
              onClick={handleStop}
              disabled={stopping}
            >
              {stopping ? 'Stopping…' : 'Confirm stop'}
            </button>
            <button
              type="button"
              className="min-h-9 border border-[#cacac7] bg-white px-3 text-xs font-semibold hover:bg-[#fcfcfb]"
              onClick={() => setShowStopConfirm(false)}
              disabled={stopping}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="flex min-h-9 items-center gap-1.5 border border-red-300 bg-red-50 px-3 text-xs font-semibold text-red-800 transition-colors hover:bg-red-100"
            onClick={() => setShowStopConfirm(true)}
            disabled={stopping}
          >
            <span aria-hidden="true">■</span> Stop
          </button>
        )}
      />
      {errorMessage && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-sm bg-red-50 border border-red-100 text-xs text-red-700">
          <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          {errorMessage}
        </div>
      )}
    </div>
  )
}
