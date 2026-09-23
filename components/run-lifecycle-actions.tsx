'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ArchiveBoxIcon, ArrowUturnLeftIcon, TrashIcon } from '@heroicons/react/24/outline'
import { isTerminalAnalysisStatus } from '@/lib/models/analysis-status'
import { RunAgainButton } from '@/components/run-again-button'

type RunLifecycleActionsProps = {
  analysis: {
    id: string
    systemName: string
    status: 'pending' | 'running' | 'completed' | 'partial' | 'failed'
    archivedAt?: string | null
  }
  selectionActive?: boolean
  onChanged: () => void
}

type LifecycleMode = 'archive' | 'restore' | 'delete'

const COPY: Record<LifecycleMode, { title: string; body: string; confirm: string; button: string }> = {
  archive: {
    title: 'Archive this analysis?',
    body: 'The analysis, findings, reviewer rationale, and report stay in this project. It will be removed from the active queue until restored.',
    confirm: 'I understand this only hides the run from the active queue.',
    button: 'Archive analysis',
  },
  restore: {
    title: 'Restore this analysis?',
    body: 'The analysis will return to the active review queue with all of its findings and history unchanged.',
    confirm: 'I understand this run will reappear in the active queue.',
    button: 'Restore analysis',
  },
  delete: {
    title: 'Permanently delete this analysis?',
    body: 'This permanently deletes the run, its findings, reviewer rationale, generated report, and local run artifacts. This cannot be undone.',
    confirm: 'I understand this permanently deletes the run and cannot be undone.',
    button: 'Delete permanently',
  },
}

export function RunLifecycleActions({ analysis, onChanged, selectionActive = false }: RunLifecycleActionsProps) {
  const [mode, setMode] = useState<LifecycleMode | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    if (!mode) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLElement>('input, button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault()
        setMode(null)
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [mode])

  // `partial` is a finished run too — hardcoding the pair here left degraded
  // runs stuck in the queue with no archive or delete control.
  const isTerminal = isTerminalAnalysisStatus(analysis.status)
  const isArchived = Boolean(analysis.archivedAt)

  function open(mode: LifecycleMode) {
    setMode(mode)
    setConfirmed(false)
    setError(null)
  }

  function close() {
    if (busy) return
    setMode(null)
    setConfirmed(false)
    setError(null)
  }

  async function submit() {
    if (!mode || !confirmed) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/v1/results/${analysis.id}`, {
        method: mode === 'delete' ? 'DELETE' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        ...(mode === 'delete' ? {} : { body: JSON.stringify({ action: mode }) }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      setMode(null)
      setConfirmed(false)
      onChanged()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="ml-auto grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_2.25rem_2.25rem] items-center gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem_2.25rem]">
        <Link
          href={`/results/${analysis.id}`}
          className="inline-flex min-h-9 w-full items-center justify-center border border-[#87978f] px-3 text-xs font-semibold text-[#333333] hover:bg-[#f5f5f3]"
        >
          {analysis.status === 'running' ? 'View live' : 'Review'}
        </Link>
        {isTerminal && (
          <>
            <RunAgainButton
              runId={analysis.id}
              mode={analysis.status === 'partial' || analysis.status === 'failed' ? 'resume' : 'fresh'}
              label={analysis.status === 'partial' || analysis.status === 'failed' ? 'Resume' : 'Run again'}
              className="inline-flex min-h-9 w-full items-center justify-center gap-1.5 border border-[#c69208] bg-[#fff7df] px-2.5 text-xs font-semibold text-[#5b4300] hover:bg-[#ffedbd] disabled:cursor-wait disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => open(isArchived ? 'restore' : 'archive')}
              disabled={selectionActive}
              className="inline-flex size-9 items-center justify-center disabled:cursor-not-allowed disabled:opacity-35 border border-[#a7b5ae] text-[#555555] hover:bg-[#f5f5f3]"
              aria-label={isArchived ? `Restore ${analysis.systemName}` : `Archive ${analysis.systemName}`}
              title={selectionActive ? 'Use the selected analyses actions above' : isArchived ? 'Restore to active queue' : 'Archive from active queue'}
            >
              {isArchived ? <ArrowUturnLeftIcon className="size-4" aria-hidden="true" /> : <ArchiveBoxIcon className="size-4" aria-hidden="true" />}
            </button>
            <button
              type="button"
              onClick={() => open('delete')}
              disabled={selectionActive}
              className="inline-flex size-9 items-center justify-center disabled:cursor-not-allowed disabled:opacity-35 border border-[#d5a7a1] text-[#a74337] hover:bg-[#fdf0ee]"
              aria-label={`Permanently delete ${analysis.systemName}`}
              title={selectionActive ? 'Use Delete selected above' : 'Permanently delete'}
            >
              <TrashIcon className="size-4" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {mode && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[#111111]/40 p-4" role="presentation">
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-lifecycle-title"
            className="w-full max-w-lg border border-[#b8c4bd] bg-[#ffffff] shadow-2xl"
          >
            <div className="border-b border-[#e4e4e2] px-5 py-4">
              <p className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[#111111]">Run lifecycle</p>
              <h2 id="run-lifecycle-title" className="mt-1 text-lg font-semibold text-[#111111]">{COPY[mode].title}</h2>
              <p className="mt-2 text-sm leading-6 text-[#666666]">{COPY[mode].body}</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm font-semibold text-[#333333]">{analysis.systemName}</p>
              <p className="mt-1 font-mono text-[11px] text-[#666666]">{analysis.id}</p>
              <label className="mt-5 flex cursor-pointer items-start gap-3 border border-[#e4e4e2] bg-white p-3 text-sm text-[#444444]">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="mt-0.5 size-4 accent-[#111111]"
                />
                <span>{COPY[mode].confirm}</span>
              </label>
              {error && <p role="alert" className="mt-3 text-xs text-red-700">{error}</p>}
            </div>
            <footer className="flex flex-wrap justify-end gap-2 border-t border-[#e4e4e2] bg-[#f1f1f0] px-5 py-4">
              <button type="button" onClick={close} disabled={busy} className="min-h-10 border border-[#9daca5] px-3 text-sm font-semibold text-[#444444] hover:bg-white disabled:opacity-50">Cancel</button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!confirmed || busy}
                className={`min-h-10 px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${mode === 'delete' ? 'bg-[#a74337] hover:bg-[#8d342b]' : 'bg-[#333333] hover:bg-[#111111]'}`}
              >
                {busy ? 'Applying…' : COPY[mode].button}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  )
}
