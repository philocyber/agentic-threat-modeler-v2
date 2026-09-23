'use client'

import { useEffect, useState } from 'react'
import { elapsedRunSeconds, formatRuntime } from '@/lib/ui/format'

export function RunDuration({
  status,
  durationSeconds,
  startedAt,
  createdAt,
}: {
  status: string
  durationSeconds?: number | null | undefined
  startedAt?: string | Date | null | undefined
  createdAt: string | Date
}) {
  const inFlight = status === 'pending' || status === 'running'
  const [now, setNow] = useState(0)

  useEffect(() => {
    if (!inFlight) return
    const tick = () => setNow(Date.now())
    tick()
    const timer = window.setInterval(tick, 1_000)
    return () => window.clearInterval(timer)
  }, [inFlight])

  const seconds = elapsedRunSeconds({
    status,
    durationSeconds,
    startedAt,
    createdAt,
    now,
  })
  return <span className="tabular-nums">{seconds === undefined ? '–' : formatRuntime(seconds)}</span>
}
