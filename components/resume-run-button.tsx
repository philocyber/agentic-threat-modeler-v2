'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { AnalysisConfig } from '@/lib/models/types'

type Props = {
  runId: string
  systemName: string
  systemId?: string | null
  input: string
  config?: AnalysisConfig | null
  reusablePhases: number
  className?: string
}

/**
 * Starts a new run that inherits the phases this one already paid for. Unlike
 * "Re-run with prefill", which opens the form for editing, this is one click:
 * the failed run's completed phases are reused and the pipeline resumes from
 * where it broke.
 */
export function ResumeRunButton({
  runId,
  systemName,
  systemId,
  input,
  config,
  reusablePhases,
  className,
}: Props) {
  const router = useRouter()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  async function resume() {
    setStarting(true)
    setError('')
    try {
      const response = await fetch('/api/v1/analyze', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemName,
          input,
          resumeFrom: runId,
          ...(systemId ? { systemId } : {}),
          ...(config ? { config } : {}),
        }),
      })
      const body = (await response.json()) as { analysisId?: string; error?: string }
      if (!response.ok || !body.analysisId) {
        throw new Error(body.error ?? 'Could not start the resumed run')
      }
      router.push(`/results/${body.analysisId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the resumed run')
      setStarting(false)
    }
  }

  return (
    <>
      <button type="button" onClick={resume} disabled={starting} className={className}>
        {starting
          ? 'Starting from checkpoints…'
          : `Run again · reuse ${reusablePhases} completed stage${reusablePhases === 1 ? '' : 's'}`}
      </button>
      {error && <p className="mt-2 w-full text-xs text-red-700">{error}</p>}
    </>
  )
}
