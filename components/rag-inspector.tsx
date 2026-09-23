import type { RAGTraceSnapshot } from '@/lib/rag/trace'
import { formatDurationMs } from '@/lib/ui/format'
import styles from './rag-inspector.module.css'

export function RAGInspector({ trace }: { trace: RAGTraceSnapshot | null }) {
  if (!trace) {
    return (
      <div className="border-t border-[#eee8ea] bg-[#fcfcfb] px-5 py-5 text-sm text-[#666666]">
        Retrieval telemetry was not captured for this earlier run. Re-run the analysis to populate the RAG Inspector.
      </div>
    )
  }

  const domains = trace.entries.flatMap((entry) => entry.selected).reduce<Record<string, number>>((counts, source) => {
    counts[source.domain] = (counts[source.domain] ?? 0) + 1
    return counts
  }, {})

  return (
    <div className={`${styles.inspector} border-t border-[#eee8ea] bg-[#fcfcfb] p-5`}>
      <div className={`${styles.metrics} grid gap-3 sm:grid-cols-2 xl:grid-cols-5`}>
        {[
          ['Queries', trace.totals.queries],
          ['Selected sources', trace.totals.sourcesSelected],
          ['Context', `${Math.round(trace.totals.charactersSelected / 1_000)}k chars`],
          ['Cache hits', trace.totals.cacheHits],
          ['Retrieval time', formatDurationMs(trace.totals.durationMs)],
        ].map(([label, value]) => (
          <div key={label} className={`${styles.metric} border border-[#e4e4e2] bg-white px-3 py-3`}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#666666]">{label}</p>
            <p className="mt-1 font-mono text-lg font-semibold text-[#111111]">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-2">
          {trace.entries.length === 0 && (
            <div className="border border-[#e4e4e2] bg-white px-5 py-5 text-sm leading-6 text-[#666666]">
              No RAG lookup was executed in this run. Retrieval can be disabled explicitly; an empty trace does not indicate that evidence was used.
            </div>
          )}
          {trace.entries.map((entry, index) => (
            <details key={entry.id} className={`${styles.entry} border border-[#e4e4e2] bg-white`} open={index === 0}>
              <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-[#111111]">
                <span className="mr-2 inline-flex bg-[#e6eee8] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[#315b4a]">{entry.profile}</span>
                {entry.selected.length} sources, {entry.selectedCharacters.toLocaleString()} / {entry.budgetCharacters.toLocaleString()} chars, {formatDurationMs(entry.durationMs)}
              </summary>
              <div className="border-t border-[#eee8ea] px-4 py-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.11em] text-[#666666]">Retrieval query</p>
                <p className="mt-1 break-words font-mono text-xs leading-5 text-[#555555]">{entry.originalQuery}</p>
                {entry.queryVariants && entry.queryVariants.length > 0 && (
                  <div className="mt-3 border-l-2 border-[#cacac7] pl-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.11em] text-[#666666]">Routed variants</p>
                    <ol className="mt-1 space-y-1 text-xs leading-5 text-[#555555]">
                      {entry.queryVariants.map((query, queryIndex) => (
                        <li key={`${entry.id}:query:${queryIndex}`} className="break-words font-mono">
                          {queryIndex + 1}. {query}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left text-xs">
                    <thead className="border-b border-[#e4e4e2] text-[10px] uppercase tracking-[0.1em] text-[#666666]"><tr><th className="pb-2">Domain</th><th className="pb-2">Source</th><th className="pb-2">Retrieval</th><th className="pb-2 text-right">Rank</th><th className="pb-2 text-right">Score</th><th className="pb-2 text-right">Chars</th></tr></thead>
                    <tbody>{entry.selected.map((source) => <tr key={`${entry.id}:${source.id}`} className="border-b border-[#fcfcfb] last:border-0"><td className="py-2 font-semibold uppercase text-[#315b4a]">{source.domain}</td><td className="max-w-[360px] break-words py-2 pr-4 text-[#555555]">{source.source}</td><td className="py-2 text-[#666666]">{source.retrieval ?? 'vector'}</td><td className="py-2 text-right font-mono">{source.rank}</td><td className="py-2 text-right font-mono">{source.fusionScore.toFixed(4)}</td><td className="py-2 text-right font-mono">{source.characters}</td></tr>)}</tbody>
                  </table>
                </div>
                {entry.selected.some(source => source.passage) && <div className="mt-4 space-y-2">
                  <h4 className="text-xs font-semibold text-[#111111]">Evidence delivered to the agent</h4>
                  {entry.selected.flatMap(source => source.passage ? [<details key={source.passage.citationId} className="border border-[#e4e4e2] p-3 text-xs leading-5">
                    <summary className="cursor-pointer break-words font-semibold">{source.source} · {source.passage.citationId}</summary>
                    <p className="mt-2 break-all font-mono">Version: {source.passage.version}</p>
                    <p className="mt-2">{['system', 'environment', 'as_of', 'doc_type', 'assertion_type'].flatMap(key => typeof source.passage?.metadata[key] === 'string' ? [`${key}: ${source.passage.metadata[key]}`] : []).join(' · ')}</p>
                    {typeof source.passage.metadata.qualification === 'string' && source.passage.metadata.qualification && <p className="mt-2">Source qualification: {source.passage.metadata.qualification}</p>}
                    <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-[#cacac7] pl-3">{source.passage.excerpt}</blockquote>
                  </details>] : [])}
                </div>}
                {entry.rejected && Object.keys(entry.rejected).length > 0 && <p className="mt-3 text-[11px] text-[#666666]">Excluded by relevance/scope: {Object.entries(entry.rejected).map(([reason, count]) => `${reason.replaceAll('_', ' ')}: ${count}`).join(' · ')}</p>}
                {entry.discardedCount > 0 && <p className="mt-3 text-[11px] text-[#666666]">{entry.discardedCount} lower-ranked or duplicate candidates were excluded.</p>}
              </div>
            </details>
          ))}
        </div>
        <aside className={`${styles.plan} border border-[#e4e4e2] bg-white p-4 text-xs`}>
          <h3 className="font-semibold text-[#111111]">Retrieval plan</h3>
          <p className="mt-1 leading-5 text-[#666666]">Built from architecture facts before analyst lookup. Version 2 traces retain the exact delivered passages; legacy traces contain metadata only. Source metadata is a claim, not proof of implementation.</p>
          {trace.candidateOutcomes?.length ? <details className="mt-4 border-t border-[#eee8ea] pt-3"><summary className="cursor-pointer font-semibold">Candidate preservation</summary><ul className="mt-2 space-y-2">{trace.candidateOutcomes.map(item => <li key={item.candidateId}>{item.candidateId}: {item.outcome.replaceAll('_', ' ')}{item.findingIds.length ? ` (${item.findingIds.length} findings)` : ' — inspect debate and filtering decisions'}</li>)}</ul></details> : null}
          <dl className="mt-4 space-y-3">
            <div><dt className="font-semibold text-[#555555]">Technical</dt><dd className="mt-1 font-mono text-[#666666]">{domains.technical ?? 0} selections</dd></div>
            <div><dt className="font-semibold text-[#555555]">Corporate</dt><dd className="mt-1 font-mono text-[#666666]">{domains.corporate ?? 0} selections</dd></div>
            <div><dt className="font-semibold text-[#555555]">Reviewer</dt><dd className="mt-1 font-mono text-[#666666]">{domains.reviewer ?? 0} selections</dd></div>
          </dl>
          {trace.plan && <div className="mt-4 space-y-3 border-t border-[#eee8ea] pt-4">
            {[
              ['Technologies', trace.plan.technologies],
              ['Controls', trace.plan.controls],
              ['Assets', trace.plan.assets],
              ['Boundaries', trace.plan.trustBoundaries],
            ].map(([label, values]) => <div key={label as string}><p className="font-semibold text-[#555555]">{label as string}</p><p className="mt-1 leading-5 text-[#666666]">{(values as string[]).join(', ') || 'None identified'}</p></div>)}
          </div>}
        </aside>
      </div>
    </div>
  )
}
