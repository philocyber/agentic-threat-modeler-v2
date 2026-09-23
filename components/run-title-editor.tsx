'use client'

import { CheckIcon, PencilSquareIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useEffect, useId, useRef, useState } from 'react'

const MAX_SYSTEM_NAME_LENGTH = 255

type Props = {
  analysisId: string
  systemName: string
  onRenamed?: (systemName: string) => void
  appearance?: 'compact' | 'heading'
}

export function RunTitleEditor({ analysisId, systemName, onRenamed, appearance = 'compact' }: Props) {
  const inputId = useId()
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(systemName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  function startEditing() {
    setDraft(systemName)
    setError(null)
    setEditing(true)
  }

  function cancel() {
    if (busy) return
    setEditing(false)
    setDraft(systemName)
    setError(null)
  }

  async function save() {
    const next = draft.trim()
    if (!next) {
      setError('Enter a system name')
      return
    }
    if (next === systemName.trim()) {
      setEditing(false)
      setError(null)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/v1/results/${encodeURIComponent(analysisId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemName: next }),
      })
      const payload = await response.json().catch(() => ({})) as { systemName?: string; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Could not rename this analysis')
      const saved = payload.systemName?.trim() || next
      setDraft(saved)
      setEditing(false)
      onRenamed?.(saved)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rename this analysis')
    } finally {
      setBusy(false)
    }
  }

  const displayName = systemName.trim() || 'Untitled analysis'
  const inputClass = appearance === 'heading'
    ? 'min-h-11 min-w-0 flex-1 border border-[#cacac7] bg-white px-3 text-xl font-semibold text-[#111111] outline-none focus:border-[#111111] focus:ring-2 focus:ring-[#111111]/20'
    : 'min-h-9 min-w-0 flex-1 border border-[#cacac7] bg-white px-2.5 text-sm font-semibold text-[#111111] outline-none focus:border-[#111111] focus:ring-2 focus:ring-[#111111]/20'
  const nameClass = appearance === 'heading'
    ? 'min-w-0 font-semibold tracking-tight text-[#111111] text-2xl'
    : 'min-w-0 truncate font-semibold text-[#111111]'

  if (editing) {
    return (
      <form
        className="min-w-0"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <label htmlFor={inputId} className="sr-only">System name</label>
          <input
            ref={inputRef}
            id={inputId}
            value={draft}
            maxLength={MAX_SYSTEM_NAME_LENGTH}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                cancel()
              }
            }}
            className={inputClass}
          />
          <button
            type="submit"
            disabled={busy}
            className="inline-flex size-9 shrink-0 items-center justify-center border border-[#c69208] bg-[#fff7df] text-[#5b4300] hover:bg-[#ffedbd] disabled:cursor-wait disabled:opacity-60"
            aria-label="Save system name"
          >
            <CheckIcon className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="inline-flex size-9 shrink-0 items-center justify-center border border-[#a7b5ae] text-[#555555] hover:bg-[#f5f5f3] disabled:cursor-wait disabled:opacity-60"
            aria-label="Cancel rename"
          >
            <XMarkIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
        {error ? <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-[#a74337]">{error}</p> : null}
      </form>
    )
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      className="group flex min-w-0 max-w-full items-center gap-1.5 text-left"
      aria-label={`Rename ${displayName}`}
      title={displayName}
    >
      <span className={nameClass}>{displayName}</span>
      <PencilSquareIcon
        className="size-4 shrink-0 text-[#8a8387] opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100"
        aria-hidden="true"
      />
    </button>
  )
}
