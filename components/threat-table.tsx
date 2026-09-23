'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { scoreLabel, severityLabel } from '@/lib/models/scoring'
import type { UnifiedThreat } from '@/lib/models/types'
import { evidenceState, nextReviewAction, reviewCounts, reviewQueueCategory, sortReviewQueue } from '@/lib/ui/review-queue'
import { parseStoredDebateRounds } from '@/lib/agents/debate-format'
import { writtenFindingConclusion } from '@/lib/agents/debate-quality'
import styles from './review-workspace.module.css'

type Props = {
  threats: UnifiedThreat[]
  initialSelectedThreatId?: string | undefined
  analysisId?: string
  debateSummary?: string | null | undefined
}

const priorityStyle: Record<string, string> = {
  critical: 'border-red-300 bg-red-50 text-red-800',
  high: 'border-orange-300 bg-orange-50 text-orange-900',
  medium: 'border-amber-300 bg-amber-50 text-amber-900',
  low: 'border-[#cacac7] bg-[#f5f5f3] text-[#333333]',
}

export function ThreatTable({ threats: original, initialSelectedThreatId, analysisId, debateSummary }: Props) {
  const router = useRouter()
  const workspaceRef = useRef<HTMLDivElement>(null)
  const [overrides, setOverrides] = useState<Record<string, UnifiedThreat>>({})
  const [selectedId, setSelectedId] = useState(original.some((item) => item.id === initialSelectedThreatId) ? initialSelectedThreatId! : sortReviewQueue(original)[0]?.id ?? '')
  const [status, setStatus] = useState('all')
  const [applicability, setApplicability] = useState('all')
  const [evidence, setEvidence] = useState('all')
  const [severity, setSeverity] = useState('all')
  const [component, setComponent] = useState('all')
  const [method, setMethod] = useState('all')
  const [ready, setReady] = useState(false)
  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [note, setNote] = useState(() => original.find((item) => item.id === selectedId)?.userComments ?? original.find((item) => item.id === selectedId)?.reviewNotes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threats = useMemo(() => original.map((item) => overrides[item.id] ?? item), [original, overrides])
  const selected = threats.find((item) => item.id === selectedId) ?? sortReviewQueue(threats)[0] ?? null
  const counts = reviewCounts(threats)
  const components = useMemo(() => [...new Set(threats.map((item) => item.component).filter(Boolean))].sort(), [threats])
  const methods = useMemo(() => [...new Set(threats.flatMap((item) => item.methodologies ?? [item.methodology]))].sort(), [threats])
  const debateRounds = useMemo(() => debateSummary ? parseStoredDebateRounds(debateSummary, threats) : [], [debateSummary, threats])
  const selectedTitle = (selected?.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const debateFinding = selected ? debateRounds.flatMap((round, roundIndex) => round.findings
    .map((finding) => ({ finding, roundIndex })))
    .filter((candidate) => candidate.finding.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === selectedTitle)
    .sort((a, b) => b.roundIndex - a.roundIndex)[0]?.finding : undefined
  const debateConclusion = debateFinding
    ? writtenFindingConclusion(debateFinding.judgeNotes)
      ?? (debateFinding.qualityIssues?.length ? 'Debate quality requires review.' : 'No written conclusion was recorded for this finding.')
    : null
  const filtered = useMemo(() => sortReviewQueue(threats.filter((item) => {
    if (status !== 'all' && (item.reviewStatus ?? 'pending') !== status) return false
    if (applicability !== 'all' && (item.disposition ?? 'applicable') !== applicability) return false
    if (evidence !== 'all' && evidenceState(item) !== evidence) return false
    if (severity !== 'all' && severityLabel(item).toLowerCase() !== severity) return false
    if (component !== 'all' && item.component !== component) return false
    if (method !== 'all' && !(item.methodologies ?? [item.methodology]).includes(method as UnifiedThreat['methodology'])) return false
    const q = search.trim().toLowerCase()
    return !q || [item.title, item.description, item.component, item.displayId].some((value) => value?.toLowerCase().includes(q))
  })), [threats, status, applicability, evidence, severity, component, method, search])
  const activeFilterCount = [status, applicability, evidence, severity, component, method].filter((value) => value !== 'all').length + Number(Boolean(search.trim()))

  const select = useCallback((item: UnifiedThreat) => {
    setSelectedId(item.id)
    setNote(item.userComments ?? item.reviewNotes ?? '')
    setError(null)
  }, [])

  /* eslint-disable react-hooks/set-state-in-effect -- URL state is restored after hydration. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setStatus(params.get('review') ?? 'all')
    setApplicability(params.get('applicability') ?? 'all')
    setEvidence(params.get('evidence') ?? 'all')
    setSeverity(params.get('severity') ?? 'all')
    setComponent(params.get('component') ?? 'all')
    setMethod(params.get('method') ?? 'all')
    setSearch(params.get('q') ?? '')
    setReady(true)
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!selected || !ready) return
    const url = new URL(window.location.href)
    url.searchParams.set('finding', selected.id)
    for (const [key, value] of Object.entries({ review: status, applicability, evidence, severity, component, method })) {
      if (value === 'all') url.searchParams.delete(key)
      else url.searchParams.set(key, value)
    }
    if (search.trim()) url.searchParams.set('q', search.trim())
    else url.searchParams.delete('q')
    window.history.replaceState(window.history.state, '', url)
  }, [selected, status, applicability, evidence, severity, component, method, search, ready])

  const patchReview = useCallback(async (reviewStatus: 'confirmed' | 'rejected' | 'pending') => {
    if (!analysisId || !selected) return
    if (reviewStatus !== 'pending' && !note.trim()) {
      setError('Add a rationale before confirming or rejecting this finding.')
      document.getElementById('review-note')?.focus()
      return
    }
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/v1/results/${analysisId}/threats/${selected.id}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_status: reviewStatus, review_notes: note.trim() || undefined }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `Review failed (${res.status})`)
      setOverrides((current) => ({ ...current, [selected.id]: body as UnifiedThreat }))
      router.refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }, [analysisId, selected, note, router])

  async function saveNote() {
    if (!analysisId || !selected) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/v1/results/${analysisId}/threats/${selected.id}/comments`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_comments: note }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`)
      setOverrides((current) => ({ ...current, [selected.id]: { ...selected, userComments: note } }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || !filtered.length) return
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'A', 'SUMMARY'].includes(event.target.tagName) || (event.target.tagName === 'BUTTON' && !event.target.hasAttribute('data-threat-id')))) return
    const index = filtered.findIndex((item) => item.id === selected?.id)
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault()
      const next = filtered[(index + (event.key === 'j' ? 1 : -1) + filtered.length) % filtered.length]!
      select(next)
      workspaceRef.current?.querySelectorAll<HTMLButtonElement>('[data-threat-id]')[filtered.findIndex((item) => item.id === next.id)]?.focus()
    } else if (event.key === 'c' || event.key === 'x') {
      event.preventDefault()
      void patchReview(event.key === 'c' ? 'confirmed' : 'rejected')
    }
  }

  return <div ref={workspaceRef} tabIndex={0} onKeyDown={onKeyDown} className={`${styles.layout} review-workspace grid min-w-0 gap-4 pb-20 focus:outline-none sm:pb-0 lg:grid-cols-2`} aria-label="Finding review workspace">
    <section className={`${styles.queue} workbench-panel min-w-0 self-start`} aria-labelledby="review-queue-title">
      <header className={`${styles.queueHeader} border-b border-[#e4e4e2] p-4 sm:p-5`}>
        <div className="flex flex-wrap items-end justify-between gap-2"><div><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#666666]">Decision queue</p><h2 id="review-queue-title" className="workbench-heading mt-1 text-xl">{counts.pending} findings to review</h2></div><div className="flex items-center gap-2"><span className="text-xs text-[#666666]">{filtered.length} shown</span><button type="button" onClick={() => setShowFilters((value) => !value)} className="min-h-9 border border-[#cacac7] px-3 text-[11px] font-semibold" aria-expanded={showFilters} aria-controls="finding-filters">Filters{activeFilterCount ? ` (${activeFilterCount})` : ''} {showFilters ? '−' : '+'}</button></div></div>
        <div id="finding-filters" hidden={!showFilters}><label className="mt-3 block"><span className="sr-only">Search findings</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search scenario, component or ID" className="min-h-10 w-full border border-[#cacac7] px-3 text-sm" /></label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Filter label="Review" value={status} onChange={setStatus} options={['pending', 'confirmed', 'rejected']} />
          <Filter label="Applicability" value={applicability} onChange={setApplicability} options={['applicable', 'conditional', 'control_verification_needed', 'mitigated', 'invalid']} />
          <Filter label="Evidence" value={evidence} onChange={setEvidence} options={['source checked', 'check quotation', 'no original source']} />
          <Filter label="Severity" value={severity} onChange={setSeverity} options={['critical', 'high', 'medium', 'low', 'unscored']} />
          <Filter label="Component" value={component} onChange={setComponent} options={components} />
          <details className="border border-[#e4e4e2] px-2 py-1"><summary className="cursor-pointer text-xs">Methodology</summary><Filter label="Method" value={method} onChange={setMethod} options={methods} /></details>
        </div>
        <p className="mt-3 text-xs leading-5 text-[#666666]">Ready to decide means pending High/Critical, validated score, applicable scenario, and a verified supporting source quotation. Provenance does not prove exploitability. <Link href="/docs" className="underline">Review guidance</Link></p></div>
      </header>
      <div className={styles.queueList}>{filtered.map((item) => <button key={item.id} data-threat-id={item.id} type="button" aria-pressed={selected?.id === item.id} onClick={() => select(item)} className={`${styles.queueRow ?? ''} ${selected?.id === item.id ? styles.selectedRow ?? '' : ''} block w-full px-4 py-4 text-left transition-colors`}>
        <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wide"><span className="font-mono text-[#666666]">{item.displayId ?? item.id}</span><span className={`border px-1.5 py-0.5 ${priorityStyle[item.priority]}`}>{severityLabel(item)}</span><span className="text-[#666666]">{item.reviewStatus ?? 'pending'}</span>{reviewQueueCategory(item) === 'actionable' && <span className="bg-[#111111] px-1.5 py-0.5 text-white">Ready to decide</span>}{selected?.id === item.id && <span className="ml-auto bg-[#111111] px-1.5 py-0.5 text-white">Selected</span>}</div>
        <p className="mt-2 text-sm font-semibold leading-5">{item.title || item.description}</p><p className="mt-1 text-xs text-[#555555]">{item.component} · {(item.disposition ?? 'applicable').replaceAll('_', ' ')} · {evidenceState(item)}</p>{selected?.id === item.id && item.evidenceSources.some((source) => source.sourceType === 'architecture' && source.supportStatus !== 'unlinked') && <p className="mt-2 bg-white/75 p-2 text-xs leading-5 text-[#555555]">Source excerpt: {evidencePreview(item, item.evidenceSources.find((source) => source.sourceType === 'architecture' && source.supportStatus !== 'unlinked')!.excerpt, 150)}</p>}<p className="mt-2 text-xs font-semibold">Next: {nextReviewAction(item)} →</p>
      </button>)}{filtered.length === 0 && <p className="p-8 text-center text-sm text-[#666666]">No findings match these filters.</p>}</div>
    </section>
    <aside id="selected-threat-details" className={`${styles.inspector} workbench-panel min-w-0 self-start scroll-mt-36`} aria-label="Selected finding">
      {selected ? <>
        <header className={`${styles.inspectorHeader} border-b border-[#e4e4e2] p-4`}><p className="font-mono text-[11px] text-[#666666]">{selected.displayId ?? selected.id} · {selected.reviewStatus ?? 'Pending review'}</p><h3 className="workbench-heading mt-1 text-lg leading-tight">{selected.title || selected.component}</h3><div className="mt-2 flex flex-wrap gap-1.5 text-[11px]"><span className={`border px-2 py-1 font-semibold ${priorityStyle[selected.priority]}`}>Severity: {severityLabel(selected)}</span><span className="border border-[#cacac7] px-2 py-1">Applicability: {(selected.disposition ?? 'applicable').replaceAll('_', ' ')}</span><span className="border border-[#cacac7] px-2 py-1">Evidence: {evidenceState(selected)}</span></div></header>
        <div className={`${styles.inspectorBody} space-y-3 p-4 text-sm leading-5`}>
          <div className={`${styles.topSections} grid gap-3 border-b border-[#e4e4e2] pb-4`}>
            <Section title="Impact"><p className={styles.fullText}>{selected.impact || 'No impact was recorded for this finding.'}</p></Section>
            <Section title="Proposed mitigation"><p className={styles.fullText}>{selected.mitigation || 'No mitigation was recorded for this finding.'}</p></Section>
          </div>
          {debateSummary && <Section title="Debate conclusion">
            <p className={styles.fullText}>{debateConclusion ?? 'No reliable finding-specific debate match was found.'}</p>
            {debateFinding?.qualityIssues?.length ? <p className="text-xs text-amber-900">Quality issue: {debateFinding.qualityIssues.join(' ')}</p> : null}
            {analysisId && <Link href={`/results/${analysisId}?section=debate&finding=${encodeURIComponent(selected.id)}`} className="text-xs font-semibold underline">View Red / Blue debate →</Link>}
          </Section>}
          {analysisId && <section id="review-finding" className="scroll-mt-36 border-t-2 border-[#111111] pt-5"><div className="flex items-center justify-between"><h4 className="font-semibold">Reviewer decision</h4><span className="text-xs capitalize">{selected.reviewStatus ?? 'pending'}</span></div><label htmlFor="review-note" className="mt-3 block text-xs font-semibold">Rationale (required to confirm or reject)</label><textarea id="review-note" rows={4} value={note} onChange={(event) => { setNote(event.target.value); setError(null) }} className="mt-2 w-full resize-y border border-[#cacac7] p-3 text-sm" placeholder="State what the source supports, what you checked, and why." />{error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}<div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void patchReview('confirmed')} className="min-h-10 bg-[#111111] px-4 text-xs font-semibold text-white disabled:opacity-50">Confirm</button><button type="button" disabled={busy} onClick={() => void patchReview('rejected')} className="min-h-10 border border-[#111111] px-4 text-xs font-semibold disabled:opacity-50">Reject</button><button type="button" disabled={busy} onClick={() => void patchReview('pending')} className="min-h-10 px-2 text-xs underline disabled:opacity-50">Return to pending</button><button type="button" disabled={busy} onClick={() => void saveNote()} className="min-h-10 px-2 text-xs underline disabled:opacity-50">Save note</button></div><p className="mt-2 text-xs text-[#666666]">Focus the review workspace for J/K navigation and C/X decisions.</p></section>}
          <details key={selected.id} className={styles.architectureDisclosure}>
            <summary>Architecture and sources</summary>
            <div className="mt-3 space-y-3">
              <Section title="Affected system and boundary"><p>{selected.component}</p>{selected.traceability?.trustBoundaries?.length ? <p className="text-xs">Boundaries: {selected.traceability.trustBoundaries.join(', ')}</p> : null}{selected.traceability?.endpoints?.length ? <p className="text-xs">Endpoints: {selected.traceability.endpoints.join(', ')}</p> : null}{analysisId && <Link href={`/results/${analysisId}?section=architecture&finding=${encodeURIComponent(selected.id)}`} className="text-xs font-semibold underline">View architecture →</Link>}</Section>
              <Section title="Preconditions and applicability">{selected.preconditions?.length ? <ul className="list-disc space-y-2 pl-5">{selected.preconditions.map((value, index) => <li key={index} className={styles.fullText}>{value}</li>)}</ul> : <p className="text-[#666666]">No explicit preconditions recorded. Verify applicability before confirming.</p>}{selected.residualRiskNotes && <p className={styles.fullText}><strong>Residual applicability:</strong> {selected.residualRiskNotes}</p>}</Section>
              <Section title="Original architecture evidence"><p className="text-xs text-[#666666]">A checked quotation confirms source text was found. It does not prove exploitability or control operation.</p>{selected.evidenceSources.some((source) => source.sourceType === 'architecture' && source.supportStatus !== 'unlinked') ? selected.evidenceSources.filter((source) => source.sourceType === 'architecture' && source.supportStatus !== 'unlinked').map((source, i) => <Evidence key={i} source={source} />) : <p className="border border-amber-300 bg-amber-50 p-3 text-xs">No linked original architecture quotation is available.</p>}</Section>
              {selected.evidenceSources.some((source) => source.sourceType === 'architecture' && source.supportStatus === 'unlinked') && <Section title="Other architecture passages"><p className="text-xs text-[#666666]">These passages are not linked to this finding.</p>{selected.evidenceSources.filter((source) => source.sourceType === 'architecture' && source.supportStatus === 'unlinked').map((source, i) => <Evidence key={i} source={source} />)}</Section>}
              {selected.evidenceSources.some((source) => source.sourceType === 'rag') && <Section title="Supporting knowledge passages">{selected.evidenceSources.filter((source) => source.sourceType === 'rag').map((source, i) => <Evidence key={i} source={source} />)}</Section>}
              <Section title="Full scenario description and control caveat"><p className={styles.fullText}>{selected.description}</p>{selected.controlReference && <p className="text-xs"><strong>Referenced controls:</strong> {selected.controlReference}</p>}<p className="text-xs text-[#666666]">Control operation is unknown until checked in the target environment. A proposed mitigation or source mention does not establish operation.</p></Section>
            </div>
          </details>
          <details className="border-t border-[#e4e4e2] pt-4"><summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide">Score, confidence and analysis history</summary><div className="mt-3 space-y-3 text-xs"><p><strong>Scenario severity:</strong> {severityLabel(selected)} · DREAD {scoreLabel(selected)}</p><p><strong>Model confidence:</strong> {Math.round(selected.confidenceScore * 100)}% is the model&apos;s estimate that its evidence and reasoning fit this scenario in the supplied material. Do not treat it as calibrated against observed incidents. It is not the likelihood of exploitation, the chance a control fails, or the severity score. Check the quoted source, preconditions, and control operation before deciding.</p><p><strong>Scoring state:</strong> {selected.scoringStatus ?? 'legacy, not recorded'}</p>{selected.scoringStatus !== 'unscored' && <dl className="grid grid-cols-2 gap-1"><dt>Damage</dt><dd>{selected.dread.damage}</dd><dt>Reproducibility</dt><dd>{selected.dread.reproducibility}</dd><dt>Exploitability</dt><dd>{selected.dread.exploitability}</dd><dt>Affected users</dt><dd>{selected.dread.affectedUsers}</dd><dt>Discoverability</dt><dd>{selected.dread.discoverability}</dd></dl>}{selected.scoringRationale && <p><strong>Scoring rationale:</strong> {selected.scoringRationale}</p>}{selected.reasoning && <p><strong>Analysis reasoning:</strong> {selected.reasoning}</p>}<p><strong>Methods:</strong> {(selected.methodologies ?? [selected.methodology]).join(', ')}</p><p><strong>Candidate IDs:</strong> {selected.sourceCandidateIds?.join(', ') || 'Not recorded'}</p></div></details>
        </div>
      </> : <p className="p-6 text-sm text-[#666666]">Select a finding to review.</p>}
    </aside>
    {analysisId && selected && <a href="#review-finding" className="fixed inset-x-0 bottom-0 z-40 flex min-h-14 items-center justify-center border-t border-[#111111] bg-white px-4 text-sm font-semibold shadow-lg sm:hidden">Review finding · {selected.displayId ?? selected.id} ↓</a>}
  </div>
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return <label className="min-w-0"><span className="sr-only">{label}</span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className="min-h-10 w-full min-w-0 border border-[#cacac7] bg-white px-2 text-xs"><option value="all">All {label.toLowerCase()}</option>{options.map((option) => <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>)}</select></label>
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className={styles.inspectorSection}><h4 className="mb-2 text-[11px] font-bold uppercase tracking-[.11em] text-[#666666]">{title}</h4><div className="space-y-2">{children}</div></section>
}
function Evidence({ source }: { source: UnifiedThreat['evidenceSources'][number] }) {
  return <div className={`${styles.evidence} border border-[#e4e4e2] bg-[#fcfcfb] p-3 text-xs`}><p className="font-semibold">{source.sourceName} · {source.referenceStatus === 'verified' ? 'quotation checked' : 'quotation unverified'}{source.supportStatus === 'unlinked' ? ' · not linked to this finding' : ''}</p><blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-[#111111] pl-3 leading-5">{source.excerpt}</blockquote>{source.citationId && <p className="mt-2 break-all font-mono text-[#666666]">{source.citationId}{source.sourceVersion ? ` · version ${source.sourceVersion}` : ''}</p>}</div>
}
function evidencePreview(threat: UnifiedThreat, excerpt: string, limit: number): string {
  if (excerpt.length <= limit) return excerpt
  const terms = new Set(`${threat.title ?? ''} ${threat.description}`.toLowerCase().match(/[a-z0-9_]{5,}/g) ?? [])
  let bestStart = 0
  let bestScore = 0
  for (let start = 0; start < excerpt.length; start += 100) {
    const window = excerpt.slice(start, start + limit).toLowerCase()
    const score = [...terms].filter((term) => window.includes(term)).length
    if (score > bestScore) { bestScore = score; bestStart = start }
  }
  const preview = excerpt.slice(bestStart, bestStart + limit).trim()
  return `${bestStart > 0 ? '…' : ''}${preview}${bestStart + limit < excerpt.length ? '…' : ''}`
}
