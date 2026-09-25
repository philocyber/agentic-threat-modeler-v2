'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import queueStyles from './analysis-queue.module.css'
import { FirstScanGuide } from '@/components/first-scan-guide'
import { ProjectWorkspace } from '@/components/project-workspace'
import { BulkRunLifecycleActions } from '@/components/bulk-run-lifecycle-actions'
import { RunLifecycleActions } from '@/components/run-lifecycle-actions'
import { formatShortDate } from '@/lib/ui/format'
import { RunTitleEditor } from '@/components/run-title-editor'
import { analysisDeliveredResults, isTerminalAnalysisStatus } from '@/lib/models/analysis-status'
import type { BulkLifecycleMode, BulkLifecycleResult } from '@/lib/ui/bulk-run-lifecycle'

type Analysis = {
  id: string
  systemName: string
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed'
  totalThreats?: number
  filteredThreats?: number
  durationSeconds?: number | null
  createdAt: string
  startedAt?: string | null
  archivedAt?: string | null
  reviewSummary?: { pending: number; actionable: number; verify: number; reviewed: number }
  isDemo?: boolean
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-900',
  running: 'bg-blue-50 text-blue-800',
  completed: 'bg-[#f1f1f0] text-[#333333]',
  partial: 'bg-amber-50 text-amber-900',
  failed: 'bg-red-50 text-red-800',
}

export default function DashboardPage() {
  const [analyses, setAnalyses] = useState<Analysis[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [projectActive, setProjectActive] = useState(false)
  const [loadingDemos, setLoadingDemos] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [showArchived, setShowArchived] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkNotice, setBulkNotice] = useState<{ tone: 'success' | 'warning'; message: string } | null>(null)
  // Background refreshes must not flash the full-page loader.
  const firstLoadDone = useRef(false)
  const selectAllDesktopRef = useRef<HTMLInputElement>(null)
  const selectAllMobileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    async function loadAnalyses() {
      if (!firstLoadDone.current) setLoading(true)
      setLoadFailed(false)
      try {
        const response = await fetch(`/api/v1/results?limit=20&includeReview=true${showArchived ? '&archived=true' : ''}`, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error('Could not load analyses')
        const body = await response.json()
        setAnalyses(body.data ?? [])
        setProjectActive(body.projectActive === true)
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setLoadFailed(true)
      } finally {
        if (!controller.signal.aborted) {
          firstLoadDone.current = true
          setLoading(false)
        }
      }
    }
    void loadAnalyses()
    return () => controller.abort()
  }, [reloadKey, showArchived])

  // The register is a snapshot, so a run that finishes while this page is open
  // used to sit at `running` until a manual reload. Refresh only while there is
  // something in flight, and stop as soon as every run reached a terminal state.
  const hasRunInFlight = analyses.some(
    (analysis) => analysis.status === 'running' || analysis.status === 'pending',
  )
  useEffect(() => {
    if (!hasRunInFlight) return
    const timer = setInterval(() => setReloadKey((value) => value + 1), 5000)
    return () => clearInterval(timer)
  }, [hasRunInFlight])

  const reviewTarget = analyses.filter((analysis) => analysisDeliveredResults(analysis.status))
    .sort((a, b) => (b.reviewSummary?.actionable ?? 0) - (a.reviewSummary?.actionable ?? 0)
      || (b.reviewSummary?.verify ?? 0) - (a.reviewSummary?.verify ?? 0)
      || (b.reviewSummary?.pending ?? 0) - (a.reviewSummary?.pending ?? 0))[0]
  const eligibleAnalyses = analyses.filter((analysis) => isTerminalAnalysisStatus(analysis.status))
  const selectedAnalyses = eligibleAnalyses.filter((analysis) => selectedIds.has(analysis.id))
  const allEligibleSelected = eligibleAnalyses.length > 0 && selectedAnalyses.length === eligibleAnalyses.length

  useEffect(() => {
    const indeterminate = selectedAnalyses.length > 0 && !allEligibleSelected
    if (selectAllDesktopRef.current) {
      selectAllDesktopRef.current.indeterminate = indeterminate
    }
    if (selectAllMobileRef.current) {
      selectAllMobileRef.current.indeterminate = indeterminate
    }
  }, [allEligibleSelected, selectedAnalyses.length])

  function handleRenamed(id: string, systemName: string) {
    setAnalyses((current) => current.map((analysis) => (
      analysis.id === id ? { ...analysis, systemName } : analysis
    )))
  }

  async function loadDemoScans() {
    setLoadingDemos(true)
    setBulkNotice(null)
    try {
      const response = await fetch('/api/v1/demo-scans', { method: 'POST' })
      const body = await response.json() as { imported?: number; existing?: number; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Could not load demo scans')
      setBulkNotice({ tone: 'success', message: `${body.imported ?? 0} demo scans loaded. ${body.existing ?? 0} already present.` })
      setReloadKey((value) => value + 1)
    } catch (error) {
      setBulkNotice({ tone: 'warning', message: error instanceof Error ? error.message : 'Could not load demo scans' })
    } finally {
      setLoadingDemos(false)
    }
  }

  function toggleAnalysis(id: string) {
    setBulkNotice(null)
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllEligible() {
    setBulkNotice(null)
    setSelectedIds(allEligibleSelected ? new Set() : new Set(eligibleAnalyses.map((analysis) => analysis.id)))
  }

  function changeArchiveView() {
    setSelectedIds(new Set())
    setBulkNotice(null)
    setShowArchived((current) => !current)
  }

  function handleBulkCompleted(mode: BulkLifecycleMode, result: BulkLifecycleResult) {
    const succeeded = result.succeeded.length
    const failed = result.failed.length
    setSelectedIds(new Set(result.failed.map((analysis) => analysis.id)))
    if (failed === 0) {
      const verb = mode === 'delete' ? 'deleted' : mode === 'restore' ? 'restored' : 'archived'
      setBulkNotice({ tone: 'success', message: `${succeeded} ${succeeded === 1 ? 'analysis' : 'analyses'} ${verb}.` })
    } else {
      setBulkNotice({
        tone: 'warning',
        message: `${succeeded} updated; ${failed} could not be updated and remain selected. ${result.failed[0]?.error ?? ''}`.trim(),
      })
    }
    if (succeeded > 0) setReloadKey((value) => value + 1)
  }

  if (loading) {
    return <div className="grid min-h-[55vh] place-items-center"><div className="workbench-panel w-full max-w-md p-5"><p className="text-sm font-semibold text-[#111111]">Loading security workspace</p><div className="mt-4 h-1.5 overflow-hidden bg-[#e4e4e2]"><div className="signal-breathe h-full w-2/3 origin-left bg-[#111111]" /></div></div></div>
  }

  return (
    <div className="space-y-4">
      <header className={queueStyles.workspaceHero}>
        <div className={queueStyles.heroCopy}>
          <p className={queueStyles.heroEyebrow}>Analysis workspace / 01</p>
          <h1>Security review starts here.</h1>
          <p>Move completed analyses through human review, keep decisions traceable, and start the next model from one place.</p>
        </div>
        <Link href="/analyze" className={queueStyles.heroAction}>Run analysis <span aria-hidden="true">↗</span></Link>
      </header>

      {loadFailed && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"><span>The analysis register could not be loaded.</span><button type="button" onClick={() => setReloadKey((value) => value + 1)} className="min-h-10 border border-amber-700 px-3 text-xs font-semibold hover:bg-amber-100">Try again</button></div>}
      {!loadFailed && analyses.length === 0 && <FirstScanGuide />}
      {!loadFailed && projectActive && analyses.length === 0 && (
        <button type="button" onClick={() => void loadDemoScans()} disabled={loadingDemos} className="min-h-11 border border-[#9daca5] bg-white px-4 text-sm font-semibold text-[#333333] disabled:opacity-50">
          {loadingDemos ? 'Loading demo scans…' : 'Explore 3 demo scans'}
        </button>
      )}
      {analyses.length === 0 && bulkNotice && <p role={bulkNotice.tone === 'warning' ? 'alert' : 'status'} className="text-sm">{bulkNotice.message}</p>}

      {!loadFailed && analyses.length > 0 && (
          <section className={`${queueStyles.queuePanel} workbench-panel min-w-0 overflow-hidden`} aria-labelledby="analysis-queue-title">
            <div className={`${queueStyles.queueHeading} flex flex-wrap items-end justify-between gap-3 border-b border-[#e4e4e2] px-5 py-4`}>
              <div><h2 id="analysis-queue-title" className="workbench-heading text-xl">{showArchived ? 'Archived analyses' : 'Analysis queue'}</h2><p className="mt-1 text-sm text-[#666666]">{showArchived ? 'Stored runs kept outside the active review queue.' : 'Recent systems, live runs, and completed review work.'}</p></div>
              <div className="flex flex-wrap items-center justify-end gap-3">{projectActive && !showArchived && analyses.filter((analysis) => analysis.isDemo).length < 3 && <button type="button" onClick={() => void loadDemoScans()} disabled={loadingDemos} className="inline-flex min-h-9 items-center border border-[#9daca5] px-3 text-xs font-semibold text-[#444444] hover:bg-[#f5f5f3] disabled:opacity-50">{loadingDemos ? 'Loading…' : 'Load 3 demo scans'}</button>}{analyses.length > 1 && !showArchived && reviewTarget && <Link href={`/results/${reviewTarget.id}`} className="inline-flex min-h-9 items-center bg-[#111111] px-3 text-xs font-semibold text-white hover:bg-[#333333]">Review priority run</Link>}<button type="button" onClick={changeArchiveView} className="min-h-9 border border-[#9daca5] px-3 text-xs font-semibold text-[#444444] hover:bg-[#f5f5f3]">{showArchived ? 'Show active queue' : 'View archived'}</button><span className="text-sm font-medium text-[#666666]">{analyses.length} {analyses.length === 1 ? 'analysis' : 'analyses'}</span></div>
            </div>
            {bulkNotice && (
              <div
                role={bulkNotice.tone === 'warning' ? 'alert' : 'status'}
                className={`border-b px-4 py-3 text-sm ${bulkNotice.tone === 'warning' ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-[#cacac7] bg-[#f5f5f3] text-[#333333]'}`}
              >
                {bulkNotice.message}
              </div>
            )}
            <BulkRunLifecycleActions
              analyses={selectedAnalyses}
              archivedView={showArchived}
              onClear={() => setSelectedIds(new Set())}
              onCompleted={handleBulkCompleted}
            />
            <label className={queueStyles.mobileSelect + ' min-h-11 gap-3 border-b border-[#e4e4e2] bg-[#fcfcfb] px-4 text-xs font-semibold text-[#666666]'}>
              <input ref={selectAllMobileRef} type="checkbox" checked={allEligibleSelected} disabled={eligibleAnalyses.length === 0} onChange={toggleAllEligible} className="size-4 accent-[#111111] disabled:cursor-not-allowed disabled:opacity-35" />
              <span>Select all finished analyses</span>
              <span className="ml-auto font-mono text-[11px]">{eligibleAnalyses.length} available</span>
            </label>
            <div className={queueStyles.mobileList + ' divide-y divide-[#e9e3e5]'}>
              {analyses.map((analysis) => {
                const eligible = isTerminalAnalysisStatus(analysis.status)
                const selected = selectedIds.has(analysis.id)
                return (
                  <article key={analysis.id} className={`${queueStyles.mobileCard} px-4 py-4 ${selected ? 'bg-[#fffaf0]' : 'bg-white'}`}>
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!eligible}
                        onChange={() => toggleAnalysis(analysis.id)}
                        className="mt-1 size-4 shrink-0 accent-[#111111] disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label={eligible ? `Select ${analysis.systemName}` : `${analysis.systemName} cannot be selected while ${analysis.status}`}
                        title={eligible ? `Select ${analysis.systemName}` : 'Only finished analyses can be archived or deleted'}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0"><h3 className="flex min-w-0 flex-wrap items-center gap-2"><RunTitleEditor analysisId={analysis.id} systemName={analysis.systemName} onRenamed={(systemName) => handleRenamed(analysis.id, systemName)} />{analysis.isDemo && <span className="border border-[#9daca5] bg-[#eef5f0] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-[#315b4a]">Demo</span>}</h3><p className="mt-1 text-xs text-[#666666]">{analysis.totalThreats ?? '–'} findings · {analysis.reviewSummary?.pending ?? '—'} pending · {formatShortDate(analysis.createdAt)}</p></div>
                          <span className={`inline-flex shrink-0 px-2 py-1 text-xs font-semibold capitalize ${STATUS_STYLE[analysis.status]}`}>{analysis.status}</span>
                        </div>
                        {analysis.status !== 'pending' && <div className="mt-3"><RunLifecycleActions selectionActive={selectedAnalyses.length > 0} analysis={analysis} onChanged={() => setReloadKey((value) => value + 1)} /></div>}
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
            <div className={queueStyles.desktopTable}>
              <table className="w-full table-fixed text-left text-sm">
                <thead className="border-b border-[#e4e4e2] bg-[#fcfcfb] text-xs font-semibold text-[#666666]"><tr><th className="w-10 px-2 py-3"><input ref={selectAllDesktopRef} type="checkbox" checked={allEligibleSelected} disabled={eligibleAnalyses.length === 0} onChange={toggleAllEligible} className="size-4 accent-[#111111] disabled:cursor-not-allowed disabled:opacity-35" aria-label={`Select all ${eligibleAnalyses.length} eligible analyses`} title="Select all finished analyses" /></th><th className="px-2 py-3">System</th><th className="w-24 px-2 py-3">Status</th><th className="w-28 px-2 py-3">Review</th><th className="w-[16rem] px-2 py-3 text-right">Actions</th></tr></thead>
                <tbody className="divide-y divide-[#e9e3e5]">
                  {analyses.map((analysis) => {
                    const eligible = isTerminalAnalysisStatus(analysis.status)
                    const selected = selectedIds.has(analysis.id)
                    return (
                      <tr key={analysis.id} className={`${queueStyles.runRow} ${selected ? 'bg-[#fffaf0]' : 'bg-white hover:bg-[#f1f1f0]'}`}>
                        <td className="px-2 py-4">
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={!eligible}
                            onChange={() => toggleAnalysis(analysis.id)}
                            className="size-4 accent-[#111111] disabled:cursor-not-allowed disabled:opacity-35"
                            aria-label={eligible ? `Select ${analysis.systemName}` : `${analysis.systemName} cannot be selected while ${analysis.status}`}
                            title={eligible ? `Select ${analysis.systemName}` : 'Only finished analyses can be archived or deleted'}
                          />
                        </td>
                        <td className="min-w-0 px-2 py-4"><div className="flex min-w-0 flex-wrap items-center gap-2"><RunTitleEditor analysisId={analysis.id} systemName={analysis.systemName} onRenamed={(systemName) => handleRenamed(analysis.id, systemName)} />{analysis.isDemo && <span className="border border-[#9daca5] bg-[#eef5f0] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-[#315b4a]">Demo</span>}</div><p className="mt-1 text-[11px] text-[#666666]">{analysis.totalThreats ?? '—'} findings · {formatShortDate(analysis.createdAt)}</p></td>
                        <td className="px-2 py-4"><span className={`inline-flex px-2 py-1 text-xs font-semibold capitalize ${STATUS_STYLE[analysis.status]}`}>{analysis.status}</span></td>
                        <td className="px-2 py-4 text-xs"><strong>{analysis.reviewSummary?.pending ?? '—'}</strong> pending<br /><span className="text-[#666666]">{analysis.reviewSummary?.actionable ?? 0} ready to decide</span></td>
                        <td className="px-2 py-4 text-right">{analysis.status !== 'pending' && <RunLifecycleActions selectionActive={selectedAnalyses.length > 0} analysis={analysis} onChanged={() => setReloadKey((value) => value + 1)} />}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
      )}

      <details className="workbench-panel"><summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-[#111111]">Manage local projects</summary><div className="border-t border-[#e4e4e2] p-4"><ProjectWorkspace /></div></details>

      <footer className={queueStyles.footer}><div><p className="font-semibold text-[#111111]">Need setup, model, RAG, or API guidance?</p><p className="mt-1 text-sm text-[#666666]">The documentation covers the complete local workflow.</p></div><Link href="/docs" className={queueStyles.footerLink}>Open documentation ↗</Link></footer>
    </div>
  )
}
