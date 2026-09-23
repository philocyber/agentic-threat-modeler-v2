'use client'

import { useEffect, useRef, useState } from 'react'
import { ArchiveBoxIcon, ArrowUturnLeftIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline'
import {
  runBulkLifecycleAction,
  type BulkLifecycleMode,
  type BulkLifecycleResult,
  type BulkLifecycleTarget,
} from '@/lib/ui/bulk-run-lifecycle'

type BulkRunLifecycleActionsProps = {
  analyses: BulkLifecycleTarget[]
  archivedView: boolean
  onClear: () => void
  onCompleted: (mode: BulkLifecycleMode, result: BulkLifecycleResult) => void
}

function actionNoun(count: number) {
  return `${count} ${count === 1 ? 'analysis' : 'analyses'}`
}

export function BulkRunLifecycleActions({
  analyses,
  archivedView,
  onClear,
  onCompleted,
}: BulkRunLifecycleActionsProps) {
  const [mode, setMode] = useState<BulkLifecycleMode | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [completed, setCompleted] = useState(0)
  const dialogRef = useRef<HTMLElement>(null)
  const busyRef = useRef(false)
  const count = analyses.length

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

  function open(nextMode: BulkLifecycleMode) {
    setMode(nextMode)
    setConfirmed(false)
    setCompleted(0)
  }

  function close() {
    if (busy) return
    setMode(null)
    setConfirmed(false)
  }

  async function submit() {
    if (!mode || !confirmed || analyses.length === 0 || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setCompleted(0)
    const result = await runBulkLifecycleAction(analyses, mode, fetch, (nextCompleted) => {
      setCompleted(nextCompleted)
    })
    busyRef.current = false
    setBusy(false)
    setMode(null)
    setConfirmed(false)
    onCompleted(mode, result)
  }

  if (count === 0) return null

  const primaryMode: BulkLifecycleMode = archivedView ? 'restore' : 'archive'
  const primaryLabel = archivedView ? 'Restore selected' : 'Archive selected'
  const title = mode === 'delete'
    ? `Permanently delete ${actionNoun(count)}?`
    : `${mode === 'restore' ? 'Restore' : 'Archive'} ${actionNoun(count)}?`
  const body = mode === 'delete'
    ? 'This permanently deletes every selected run, its findings, reviewer rationale, generated report, and local run artifacts. This cannot be undone.'
    : mode === 'restore'
      ? 'The selected analyses will return to the active review queue with all findings and history unchanged.'
      : 'The selected analyses and their findings stay in this project, but leave the active review queue until restored.'
  const confirmation = mode === 'delete'
    ? `I understand ${actionNoun(count)} will be permanently deleted and cannot be recovered.`
    : `I understand ${actionNoun(count)} will be ${mode === 'restore' ? 'restored' : 'archived'}.`

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-[#e3cf91] bg-[#fff8df] px-4 py-3" role="region" aria-label="Bulk actions">
        <span className="mr-auto text-sm font-semibold text-[#111111]">{count} selected. Use these actions for the selection.</span>
        <button
          type="button"
          onClick={() => open(primaryMode)}
          className="inline-flex min-h-9 items-center gap-2 border border-[#8f9e96] bg-white px-3 text-xs font-semibold text-[#333333] hover:bg-[#f5f5f3]"
        >
          {archivedView ? <ArrowUturnLeftIcon className="size-4" aria-hidden="true" /> : <ArchiveBoxIcon className="size-4" aria-hidden="true" />}
          {primaryLabel}
        </button>
        <button
          type="button"
          onClick={() => open('delete')}
          className="inline-flex min-h-9 items-center gap-2 border border-[#d5a7a1] bg-white px-3 text-xs font-semibold text-[#a74337] hover:bg-[#fdf0ee]"
        >
          <TrashIcon className="size-4" aria-hidden="true" />
          Delete selected
        </button>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex size-9 items-center justify-center text-[#666666] hover:bg-white"
          aria-label="Clear selection"
          title="Clear selection"
        >
          <XMarkIcon className="size-4" aria-hidden="true" />
        </button>
      </div>

      {mode && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[#111111]/40 p-4" role="presentation">
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-lifecycle-title"
            className="w-full max-w-lg border border-[#b8c4bd] bg-white shadow-2xl"
          >
            <div className="border-b border-[#e4e4e2] px-5 py-4">
              <p className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[#111111]">Bulk run lifecycle</p>
              <h2 id="bulk-lifecycle-title" className="mt-1 text-lg font-semibold text-[#111111]">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-[#666666]">{body}</p>
            </div>
            <div className="px-5 py-4">
              <ul className="max-h-36 space-y-1 overflow-y-auto border border-[#e4e4e2] bg-[#f1f1f0] p-3 text-sm text-[#444444]">
                {analyses.map((analysis) => <li key={analysis.id}>{analysis.systemName}</li>)}
              </ul>
              <label className="mt-4 flex cursor-pointer items-start gap-3 border border-[#e4e4e2] bg-white p-3 text-sm text-[#444444]">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="mt-0.5 size-4 accent-[#111111]"
                />
                <span>{confirmation}</span>
              </label>
            </div>
            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e4e4e2] bg-[#f1f1f0] px-5 py-4">
              <span className="text-xs text-[#666666]" aria-live="polite">{busy ? `Applying ${completed} of ${count}…` : `${count} selected`}</span>
              <div className="flex gap-2">
                <button type="button" onClick={close} disabled={busy} className="min-h-10 border border-[#9daca5] px-3 text-sm font-semibold text-[#444444] hover:bg-white disabled:opacity-50">Cancel</button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!confirmed || busy}
                  className={`min-h-10 px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${mode === 'delete' ? 'bg-[#a74337] hover:bg-[#8d342b]' : 'bg-[#333333] hover:bg-[#111111]'}`}
                >
                  {busy ? 'Applying…' : mode === 'delete' ? 'Delete permanently' : mode === 'restore' ? 'Restore analyses' : 'Archive analyses'}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </>
  )
}
