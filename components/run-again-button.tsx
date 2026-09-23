'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { RunInputBundle } from '@/lib/runs/input-bundle'
import { buildRerunRequest, type RerunMode } from '@/lib/runs/rerun-request'

type Props = {
  runId: string
  mode: RerunMode
  label?: string
  className?: string
}

export function RunAgainButton({ runId, mode, label, className }: Props) {
  const router = useRouter()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [canStartFresh, setCanStartFresh] = useState(false)

  async function start(requestedMode: RerunMode = mode) {
    setStarting(true)
    setError('')
    setCanStartFresh(false)
    try {
      const inputsResponse = await fetch(
        `/api/v1/results/${encodeURIComponent(runId)}?format=inputs`,
        { credentials: 'include', cache: 'no-store' },
      )
      const bundle = (await inputsResponse.json()) as RunInputBundle & { error?: string }
      if (!inputsResponse.ok || !bundle.systemName || !bundle.effectiveInput) {
        throw new Error(bundle.error ?? 'Could not load the saved run inputs')
      }

      const response = await fetch('/api/v1/analyze', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRerunRequest(bundle, requestedMode)),
      })
      const payload = (await response.json()) as { analysisId?: string; error?: string; code?: string }
      if (!response.ok || !payload.analysisId) {
        if (response.status === 409 && payload.code === 'CHECKPOINT_INCOMPATIBLE') {
          setCanStartFresh(true)
        }
        throw new Error(payload.error ?? 'Could not start the analysis')
      }
      router.push(`/results/${payload.analysisId}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the analysis')
      setStarting(false)
    }
  }

  const defaultLabel = mode === 'resume' ? 'Resume failed stages' : 'Run again'

  return (
    <span className="relative inline-flex flex-col items-end">
      <button
        type="button"
        onClick={() => void start()}
        disabled={starting}
        className={className}
        aria-describedby={error ? `rerun-error-${runId}` : undefined}
      >
        <svg className="size-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M5.6 15a7 7 0 0011.9 2M18.4 9A7 7 0 006.5 7" />
        </svg>
        {starting ? (mode === 'resume' ? 'Resuming…' : 'Starting…') : (label ?? defaultLabel)}
      </button>
      {error ? (
        <span
          id={`rerun-error-${runId}`}
          role="alert"
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-64 border border-red-200 bg-red-50 px-3 py-2 text-left text-[11px] font-medium leading-4 text-red-800 shadow-lg"
        >
          {error}
          {canStartFresh ? (
            <button
              type="button"
              onClick={() => void start('fresh')}
              className="mt-2 block font-semibold underline underline-offset-2"
            >
              Start a new run instead
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
