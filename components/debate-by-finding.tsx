'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import type { UnifiedThreat } from '@/lib/models/types'
import { parseStoredDebateRounds, type ParsedDebateRound } from '@/lib/agents/debate-format'
import { writtenFindingConclusion } from '@/lib/agents/debate-quality'
import styles from './debate-by-finding.module.css'

type Finding = ParsedDebateRound['findings'][number]
type Group = { key: string; id: string; title: string; component: string; turns: Array<{ round: ParsedDebateRound; finding: Finding }> }

function linkedThreat(group: Group, threats: UnifiedThreat[]): UnifiedThreat | undefined {
  const title = group.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const matches = threats.filter((threat) => (threat.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === title)
  if (matches.length === 1) return matches[0]
  return matches.find((threat) => threat.component.toLowerCase() === group.component.toLowerCase())
}

function CompactDebateText({ text, limit }: { text: string; limit: number }) {
  if (text.length <= limit) return <p className="mt-2 whitespace-pre-wrap text-xs leading-5">{text}</p>
  return <><p className="mt-2 text-xs leading-5">{text.slice(0, limit).trimEnd()}…</p><details className="mt-2 text-xs"><summary className="cursor-pointer font-semibold">Read full position</summary><p className="mt-2 whitespace-pre-wrap leading-5">{text}</p></details></>
}

function groupRounds(rounds: ParsedDebateRound[]): Group[] {
  const groups = new Map<string, Group>()
  for (const round of rounds) for (const finding of round.findings) {
    const key = finding.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const current = groups.get(key)
    if (current) { current.turns.push({ round, finding }); current.title = finding.title }
    else groups.set(key, { key, id: finding.id, title: finding.title, component: finding.component, turns: [{ round, finding }] })
  }
  return [...groups.values()]
}

export function DebateByFinding({ summary, threats, analysisId }: { summary: string; threats: UnifiedThreat[]; analysisId: string }) {
  const rounds = useMemo(() => parseStoredDebateRounds(summary, threats), [summary, threats])
  const groups = useMemo(() => groupRounds(rounds), [rounds])
  const [selectedKey, setSelectedKey] = useState(groups[0]?.key ?? '')
  const [roundIndex, setRoundIndex] = useState(0)
  const listRef = useRef<HTMLElement>(null)
  /* eslint-disable react-hooks/set-state-in-effect -- Restore the finding deep link after hydration. */
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('finding')
    const match = groups.find((group) => linkedThreat(group, threats)?.id === requested)
    if (match) setSelectedKey(match.key)
  }, [groups, threats])
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    const list = listRef.current
    const current = list?.querySelector<HTMLButtonElement>('[aria-current="true"]')
    if (!list || !current) return
    if (current.offsetTop < list.scrollTop || current.offsetTop + current.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, current.offsetTop - 12)
    }
  }, [selectedKey])
  const selected = groups.find((group) => group.key === selectedKey) ?? groups[0]
  const index = selected ? Math.min(roundIndex, selected.turns.length - 1) : 0
  const active = selected?.turns[index]
  const latest = selected?.turns[selected.turns.length - 1]?.finding
  const linked = selected ? linkedThreat(selected, threats) : undefined
  const conclusion = writtenFindingConclusion(latest?.judgeNotes) ?? (latest?.qualityIssues?.length ? 'Debate quality requires review.' : 'No written conclusion was recorded for this finding.')
  function choose(group: Group) {
    setSelectedKey(group.key); setRoundIndex(0)
    const url = new URL(window.location.href)
    const threat = linkedThreat(group, threats)
    if (threat) url.searchParams.set('finding', threat.id)
    else url.searchParams.delete('finding')
    window.history.replaceState(window.history.state, '', url)
  }
  if (!selected || !active) return <p className="text-sm text-[#666666]">No finding-specific debate was preserved for this run.</p>
  return <div className="space-y-4">
    <header><p className="text-[11px] font-bold uppercase tracking-wide text-[#666666]">Adversarial validation</p><h3 className="workbench-heading mt-1 text-lg">Red / Blue debate by finding</h3><p className="mt-1 text-sm text-[#666666]">Read one finding across its rounds. The recorded conclusion is an analysis result, not a reviewer decision.</p></header>
    {rounds.some((round) => round.findings.some((finding) => finding.redReplyNotes)) && <p className="border border-amber-300 bg-amber-50 p-3 text-xs">This historical debate includes an extra Red reply. It is preserved in its original round.</p>}
    <label className={`${styles.mobilePicker} text-xs font-semibold`}>Choose finding<select aria-label="Choose debate finding" value={selected.key} onChange={(event) => { const group = groups.find((item) => item.key === event.target.value); if (group) choose(group) }} className="mt-2 min-h-10 w-full border border-[#cacac7] bg-white px-2 text-sm">{groups.map((group) => <option key={group.key} value={group.key}>{linkedThreat(group, threats)?.displayId ?? 'Transcript'} · {group.title}</option>)}</select></label>
    <div className={styles.layout}>
      <div className={styles.listSlot}><nav ref={listRef} aria-label="Debate findings" className={`${styles.list} border border-[#cacac7] bg-white`}>{groups.map((group) => {
        const last = group.turns[group.turns.length - 1]?.finding
        const linked = linkedThreat(group, threats)
        return <button key={group.key} type="button" onClick={() => choose(group)} aria-current={selected.key === group.key ? 'true' : undefined} className="block w-full px-4 py-3 text-left"><span className={styles.listMeta}><span className="font-mono text-[10px] font-bold text-[#666666]">{linked?.displayId ?? 'Transcript only'} · {group.turns.length} round{group.turns.length === 1 ? '' : 's'}</span>{selected.key === group.key && <span className={styles.selectedMarker}>Selected</span>}</span><span className="mt-1 block text-sm font-semibold leading-5">{group.title}</span><span className="mt-1 block text-xs text-[#666666]">{group.component} · {last?.qualityIssues?.length ? 'Review required' : last?.finalVerdict ?? 'Unresolved'}</span></button>
      })}</nav></div>
      <article className={`${styles.article} min-w-0 border border-[#cacac7] bg-white`}>
        <header className="border-b border-[#e4e4e2] p-4"><div className="flex flex-wrap items-center gap-2"><span className="bg-[#111111] px-2 py-0.5 font-mono text-[10px] font-bold text-white">{linked?.displayId ?? 'Transcript only'}</span><span className="border border-[#cacac7] px-2 py-0.5 text-[10px] font-bold uppercase">{latest?.qualityIssues?.length ? 'Review required' : `Final: ${latest?.finalVerdict ?? 'unresolved'}`}</span></div><div className={styles.titleRow}><h4 className="workbench-heading text-base">{selected.title}</h4>{linked && <Link href={`/results/${analysisId}?section=findings&finding=${encodeURIComponent(linked.id)}`} className={styles.reviewLink}>Review finding ↗</Link>}</div><p className="mt-1 text-xs text-[#666666]">{selected.component}</p>{linked?.displayId !== selected.id && <p className="mt-2 text-xs text-amber-900">Saved transcript label: {selected.id}. Linked by exact scenario title to {linked?.displayId ?? 'no final finding'}.</p>}</header>
        <div className={`${styles.conclusion} border-b border-[#e4e4e2] p-4`}><p className="text-[10px] font-bold uppercase tracking-wide text-[#666666]">Recorded conclusion</p><p className={styles.conclusionText}>{conclusion}</p>{latest?.qualityIssues?.length ? <p className="mt-2 text-xs text-amber-900">Quality issue: {latest.qualityIssues.join(' ')}</p> : null}</div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e4e4e2] p-3"><p className="text-xs font-semibold">Round {active.round.number} of {selected.turns.length}{active.finding.provisional ? ' · interim' : ' · final'}</p><div className="flex gap-2"><button type="button" disabled={index === 0} onClick={() => setRoundIndex(index - 1)} className="min-h-9 border border-[#cacac7] px-3 text-xs font-semibold disabled:opacity-40" aria-label="Previous debate round">← Previous</button><button type="button" disabled={index >= selected.turns.length - 1} onClick={() => setRoundIndex(index + 1)} className="min-h-9 border border-[#cacac7] px-3 text-xs font-semibold disabled:opacity-40" aria-label="Next debate round">Next →</button></div></div>
        <div className={styles.roundPositions}><section className="border-b border-[#e4e4e2] p-4 lg:border-b-0 lg:border-r"><p className="text-[11px] font-bold uppercase tracking-wide text-[#9d2f27]">Red Team · {active.finding.redVerdict}</p><CompactDebateText text={active.finding.redNotes || active.round.redOverview || 'No separate offensive position was recorded.'} limit={360} /></section><section className="p-4"><p className="text-[11px] font-bold uppercase tracking-wide text-[#245b86]">Blue Team · {active.finding.blueVerdict}</p><CompactDebateText text={active.finding.blueNotes || active.round.blueOverview || 'No separate defensive response was recorded.'} limit={360} /></section></div>
        {active.finding.redReplyNotes && <details className="border-t border-[#e4e4e2] p-4 text-xs"><summary className="cursor-pointer font-semibold">Legacy extra Red reply</summary><p className="mt-2 leading-5">{active.finding.redReplyNotes}</p></details>}
        {active.finding.provisional && active.finding.judgeNotes && <details className="border-t border-[#e4e4e2] p-3 text-xs"><summary className="cursor-pointer font-semibold">Interim round analysis note</summary><p className="mt-2 leading-5">{active.finding.judgeNotes}</p></details>}
        {active.round.judge && <details className="border-t border-[#e4e4e2] p-4 text-xs"><summary className="cursor-pointer font-semibold">Full independent adjudication</summary><p className="mt-2 leading-5">{active.round.judge}</p></details>}
      </article>
    </div>
  </div>
}
