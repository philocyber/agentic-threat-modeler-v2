'use client'

import { useEffect, useState } from 'react'

type SystemRow = {
  id: string
  name: string
  description: string | null
}

type Props = {
  systemName: string
  systemId?: string | undefined
  onSelect: (next: { systemName: string; systemId?: string | undefined }) => void
  disabled?: boolean
}

export function SystemPicker({ systemName, systemId, onSelect, disabled }: Props) {
  const [systems, setSystems] = useState<SystemRow[]>([])
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const res = await fetch('/api/v1/systems', { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) {
          setLoadError('Could not load systems')
          return
        }
        const body = (await res.json()) as { data?: SystemRow[] }
        setSystems(body.data ?? [])
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setLoadError('Could not load systems')
        }
      }
    }
    load()
    return () => controller.abort()
  }, [])

  function handlePick(value: string) {
    if (!value) {
      onSelect({ systemName, systemId: undefined })
      return
    }
    const match = systems.find((s) => s.id === value)
    if (!match) return
    onSelect({ systemName: match.name, systemId: match.id })
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor="system-picker" className="block text-sm font-medium text-slate-700">
        Existing system (reuse its review history)
      </label>
      <select
        id="system-picker"
        className="w-full px-3.5 py-2.5 rounded-sm border border-slate-300 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
        value={systemId ?? ''}
        onChange={(e) => handlePick(e.target.value)}
        disabled={disabled}
        aria-label="Select an existing system"
      >
        <option value="">New system — type a name below</option>
        {systems.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {loadError && <p className="text-xs text-amber-700">{loadError}</p>}
      {systemId && (
        <p className="text-xs text-slate-500">
          Linked to system <span className="font-mono">{systemId.slice(0, 8)}</span>. Eligible reviewer decisions from its completed runs can inform this scan.
        </p>
      )}
    </div>
  )
}
