'use client'

import type { HealthStatus } from '@/lib/models/types'

export function RagRunSettings({
  enabled,
  onChange,
  health,
}: {
  enabled: boolean
  onChange: (enabled: boolean) => void
  health: HealthStatus | null
}) {
  const rag = health?.rag
  const ragBlocked = Boolean(rag && !rag.usable)
  const ragWarning = Boolean(rag?.usable && rag.warning)

  return (
    <section className="workbench-panel p-5 sm:p-6" aria-labelledby="rag-settings-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 id="rag-settings-title" className="text-sm font-semibold text-[#111111]">
            Knowledge retrieval
          </h2>
          <p className="mt-1 text-sm leading-6 text-[#666666]">
            RAG is on by default. Analysts retrieve security knowledge from Chroma. Turn it off only when you want an architecture-only scan.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onChange(!enabled)}
          className={`inline-flex min-h-11 min-w-[9.5rem] items-center justify-center px-4 text-xs font-semibold ${
            enabled
              ? 'bg-[#111111] text-white hover:bg-[#333333]'
              : 'border border-[#cacac7] bg-white text-[#333333] hover:bg-[#fcfcfb]'
          }`}
        >
          {enabled ? 'RAG on' : 'RAG off'}
        </button>
      </div>

      {ragBlocked && rag ? (
        <p className="mt-4 text-xs leading-5 text-[#9a3412]">
          {rag.reason} A scan with RAG on will not start until retrieval is usable. The banner at the top of this page has the recovery steps.
        </p>
      ) : ragWarning && rag ? (
        <p className="mt-4 text-xs leading-5 text-[#9a3412]">
          {rag.warning} You can still start the scan; vector hits will be missing until Knowledge is indexed.
        </p>
      ) : rag?.usable ? (
        <p className="mt-4 text-xs leading-5 text-[#218848]">
          Retrieval is ready at {rag.endpoint}
          {rag.documentCount != null ? ` (${rag.documentCount} indexed documents, ${rag.pageIndexNodes} page-index nodes)` : ` (${rag.pageIndexNodes} page-index nodes)`}
          . This scan will retrieve knowledge unless you turn RAG off.
        </p>
      ) : null}
    </section>
  )
}
