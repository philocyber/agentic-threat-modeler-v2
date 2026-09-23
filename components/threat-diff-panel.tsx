'use client'

import { useEffect, useState } from 'react'

type ThreatDiffResult = {
  baseRunId?: string
  compareRunId?: string
  added: Array<{ title: string; component: string; priority: string; description?: string }>
  removed: Array<{ title: string; component: string; priority: string; description?: string }>
  changed: Array<{ title: string; component: string; priority: string; changedFields: string[]; after: { priority: string } }>
  unchangedCount: number
  base?: { id: string; versionHash: string; completedAt: string | null }
  compare?: { id: string; versionHash: string; completedAt: string | null }
}

type Props = {
  runId: string
  siblingRuns: Array<{ id: string; title: string | null; versionHash: string; completedAt: Date | string | null }>
}

export function ThreatDiffPanel({ runId, siblingRuns }: Props) {
  const [compareWith, setCompareWith] = useState('')
  const [diff, setDiff] = useState<ThreatDiffResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const options = siblingRuns.filter((r) => r.id !== runId)

  useEffect(() => {
    if (!compareWith) return
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setError('')
      try {
        const res = await fetch(`/api/v1/results/${compareWith}/diff?compareWith=${encodeURIComponent(runId)}`, {
          signal: controller.signal,
        })
        if (!res.ok) {
          const errorBody = await res.json().catch(() => ({})) as { error?: unknown }
          throw new Error(typeof errorBody.error === 'string'
            ? errorBody.error.slice(0, 200)
            : `Diff request failed (status ${res.status})`)
        }
        const body = await res.json()
        setDiff(body.data)
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    load()
    return () => controller.abort()
  }, [runId, compareWith])

  function exportDiffJson() {
    if (!diff) return
    const blob = new Blob([JSON.stringify(diff, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `threat-diff-${runId.slice(0, 8)}-${compareWith.slice(0, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (options.length === 0) return null

  return (
    <div className="ledger-panel p-5 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <p className="ledger-label">Compare runs</p>
          <p className="text-sm text-[#666666] mt-1">Diff threats against another completed run of this system.</p>
        </div>
        <select
          className="ml-auto min-w-[220px] px-3 py-2 rounded-sm border border-slate-300 text-sm bg-white"
          value={compareWith}
          onChange={(e) => {
            setCompareWith(e.target.value)
            setDiff(null)
            setError('')
            setShowAll(false)
          }}
          aria-label="Select run to compare"
        >
          <option value="">Select prior run…</option>
          {options.map((run) => (
            <option key={run.id} value={run.id}>
              {run.title ?? run.id} ({run.versionHash.slice(0, 8)})
            </option>
          ))}
        </select>
        {diff && !loading && (
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            className="px-3 py-2 rounded-sm border border-slate-300 text-sm text-slate-800 hover:bg-slate-50"
          >
            {showAll ? 'Show first 5' : 'Show all'}
          </button>
        )}
        {diff && !loading && (
          <button
            type="button"
            onClick={exportDiffJson}
            className="px-3 py-2 rounded-sm border border-slate-300 text-sm text-slate-800 hover:bg-slate-50"
          >
            Export JSON
          </button>
        )}
      </div>

      {loading && <p className="text-sm text-slate-500">Computing diff…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {diff && !loading && (
        <div className="border-l-4 border-[#111111] bg-[#fcfcfb] p-4 text-sm">
          <p className="font-semibold">High / Critical changes in this run</p>
          <p className="mt-1 text-xs text-[#666666]">Added or changed relative to the selected prior run. Compare source evidence before accepting a change.</p>
          <ul className="mt-2 space-y-1 text-xs">
            {diff.added.filter((item) => item.priority === 'high' || item.priority === 'critical').map((item) => <li key={`added-${item.component}-${item.title}`}>Added · {item.priority.toUpperCase()} · {item.title}</li>)}
            {diff.changed.filter((item) => item.after.priority === 'high' || item.after.priority === 'critical').map((item) => <li key={`changed-${item.component}-${item.title}`}>Changed · {item.after.priority.toUpperCase()} · {item.title} ({item.changedFields.join(', ')})</li>)}
            {!diff.added.some((item) => item.priority === 'high' || item.priority === 'critical') && !diff.changed.some((item) => item.after.priority === 'high' || item.after.priority === 'critical') && <li>No added or changed High/Critical findings.</li>}
          </ul>
        </div>
      )}

      {diff && !loading && (
        <div className="grid gap-3 md:grid-cols-3 text-sm">
          <div className="rounded-sm border border-[#cacac7] bg-[#f1f1f0] p-3">
            <p className="font-semibold text-[#111111]">Added ({diff.added.length})</p>
            <ul className="mt-2 space-y-1 text-[#333333]">
              {diff.added.slice(0, showAll ? undefined : 5).map((t) => (
                <li key={`${t.component}-${t.title}`}>{t.title}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-sm border border-red-200 bg-red-50 p-3">
            <p className="font-semibold text-red-800">Removed ({diff.removed.length})</p>
            <ul className="mt-2 space-y-1 text-red-900">
              {diff.removed.slice(0, showAll ? undefined : 5).map((t) => (
                <li key={`${t.component}-${t.title}`}>{t.title}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-sm border border-amber-200 bg-amber-50 p-3">
            <p className="font-semibold text-amber-800">Changed ({diff.changed.length})</p>
            <ul className="mt-2 space-y-1 text-amber-900">
              {diff.changed.slice(0, showAll ? undefined : 5).map((t) => (
                <li key={`${t.component}-${t.title}`}>{t.title} ({t.changedFields.join(', ')})</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
