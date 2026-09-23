'use client'

import { useEffect, useRef, useState } from 'react'
import { RerunLink } from '@/components/rerun-link'
import { RunTelemetryWindow } from '@/components/run-telemetry'
import type { RunInputBundle } from '@/lib/runs/input-bundle'
import { PROVIDER_METADATA } from '@/lib/llm/providers'
import { MarkdownViewer } from '@/components/markdown-viewer'
import styles from './run-inputs-panel.module.css'
import { formatAnalysisRequest } from '@/lib/ui/format-analysis-request'

type CopyTarget = 'prompt' | 'effective' | 'bundle' | null

const PROFILE_LABELS = {
  local_efficient: 'Local Efficient',
  provider_optimized: 'Provider Optimized',
  provider_full_power: 'Provider Full Power',
  adaptive_value: 'Adaptive Value',
} as const

export function RunInputsPanel({
  bundle,
  live = false,
  showTelemetry = true,
}: {
  bundle: RunInputBundle
  live?: boolean
  showTelemetry?: boolean
}) {
  const [copied, setCopied] = useState<CopyTarget>(null)
  const copyTimer = useRef<number | null>(null)
  const config = bundle.executionConfig

  async function copyText(target: Exclude<CopyTarget, null>, value: string) {
    await navigator.clipboard.writeText(value)
    setCopied(target)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(null), 1800)
  }

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])

  function downloadBundle() {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${bundle.runId}-inputs.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section id="run-inputs" className="workbench-panel scroll-mt-24 overflow-hidden" aria-labelledby="run-inputs-title">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <span>
          <span id="run-inputs-title" className="workbench-heading block text-lg">Run inputs</span>
          <span className="mt-1 block max-w-2xl text-sm leading-6 text-[#666666]">
            Reproducibility log: original request, document references and routing snapshot.
          </span>
        </span>
        <span className="shrink-0 border border-[#cacac7] bg-[#fcfcfb] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[#666666]">
          Audit log
        </span>
      </div>

      {showTelemetry && <RunTelemetryWindow analysisId={bundle.runId} live={live} />}

      <details>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 border-t border-[#e4e4e2] px-5 py-3 text-sm font-semibold text-[#111111] marker:content-none">
          Prompt and routing snapshot
        </summary>

        <div className="border-t border-[#e4e4e2]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e4e4e2] bg-[#fcfcfb] px-5 py-3">
            <p className="text-xs leading-5 text-[#666666]">Kept in the UI for evidence and reruns; intentionally excluded from the executive PDF.</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => copyText('bundle', JSON.stringify(bundle, null, 2))}
                className="min-h-9 border border-[#cacac7] bg-white px-3 text-xs font-semibold text-[#444444] hover:bg-[#fcfcfb]"
              >
                {copied === 'bundle' ? 'Bundle copied' : 'Copy bundle'}
              </button>
              <button
                type="button"
                onClick={downloadBundle}
                className="min-h-9 border border-[#cacac7] bg-white px-3 text-xs font-semibold text-[#444444] hover:bg-[#fcfcfb]"
              >
                Download JSON
              </button>
              <RerunLink
                systemName={bundle.systemName}
                systemId={bundle.systemId}
                rerunFrom={bundle.runId}
                className="inline-flex min-h-9 items-center bg-[#111111] px-3 text-xs font-semibold text-white hover:bg-[#333333]"
              >
                Use as new run
              </RerunLink>
            </div>
          </div>

          <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 border-b border-[#e4e4e2] p-5 lg:border-b-0 lg:border-r">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[#111111]">Analysis request</h3>
              <p className="mt-1 text-xs text-[#666666]">The user-authored prompt before document extraction was appended.</p>
            </div>
            <button
              type="button"
              onClick={() => copyText('prompt', bundle.sourceInput)}
              className="min-h-8 border border-[#cacac7] px-2.5 text-[11px] font-semibold text-[#666666] hover:bg-[#fcfcfb]"
            >
              {copied === 'prompt' ? 'Copied' : 'Copy prompt'}
            </button>
          </div>
          <div className="max-h-96 overflow-auto border border-[#e4e4e2] bg-[#fcfcfb] p-4">
            {bundle.sourceInput ? <MarkdownViewer content={formatAnalysisRequest(bundle.sourceInput)} className={styles.prompt ?? ''} /> : <p className="text-xs text-[#666666]">No original prompt was preserved.</p>}
          </div>
          {bundle.sourceInput && <details className="mt-3 text-xs text-[#555555]"><summary className="cursor-pointer font-semibold">View raw Markdown</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border border-[#e4e4e2] p-3 font-mono text-xs leading-5">{bundle.sourceInput}</pre></details>}
          {bundle.supportingDocuments.length > 0 ? (
            <button
              type="button"
              onClick={() => copyText('effective', bundle.effectiveInput)}
              className="mt-3 text-xs font-semibold text-[#111111] underline underline-offset-2"
            >
              {copied === 'effective' ? 'Effective input copied' : 'Copy prompt with extracted document text'}
            </button>
          ) : null}
        </div>

        <div className="space-y-5 bg-[#fcfcfb] p-5">
          <section aria-labelledby="run-documents-title">
            <h3 id="run-documents-title" className="text-xs font-bold uppercase tracking-[0.09em] text-[#666666]">
              Supporting documents
            </h3>
            {bundle.supportingDocuments.length > 0 ? (
              <>
                <ul className="mt-3 space-y-2">
                  {bundle.supportingDocuments.map((document) => (
                    <li key={document.upload_id} className="border border-[#e4e4e2] bg-white px-3 py-2">
                      <span className="block break-words text-xs font-semibold text-[#333333]">{document.name}</span>
                      <span className="mt-1 block font-mono text-[10px] uppercase tracking-wide text-[#666666]">{document.type}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-5 text-[#666666]">
                  Extracted document content is preserved in the effective input. Original binary files are not duplicated.
                </p>
              </>
            ) : (
              <p className="mt-2 text-xs leading-5 text-[#666666]">No separate supporting documents were attached.</p>
            )}
          </section>

          <section aria-labelledby="run-routing-title">
            <h3 id="run-routing-title" className="text-xs font-bold uppercase tracking-[0.09em] text-[#666666]">
              Execution snapshot
            </h3>
            {config ? (
              <dl className="mt-3 grid grid-cols-[92px_1fr] gap-x-3 gap-y-2 text-xs">
                <dt className="text-[#666666]">Provider</dt>
                <dd className="font-semibold text-[#333333]">{PROVIDER_METADATA[config.provider].label}</dd>
                <dt className="text-[#666666]">Profile</dt>
                <dd className="font-semibold text-[#333333]">{PROFILE_LABELS[config.executionProfile ?? 'local_efficient']}</dd>
                <dt className="text-[#666666]">Mode</dt>
                <dd className="font-semibold capitalize text-[#333333]">{config.executionMode}</dd>
                <dt className="text-[#666666]">Analysts</dt>
                <dd className="font-semibold text-[#333333]">{config.enabledAnalysts.join(', ')}</dd>
                <dt className="text-[#666666]">Models</dt>
                <dd className="break-words font-mono text-[11px] text-[#333333]">{config.quickModel} / {config.deepModel}</dd>
                <dt className="text-[#666666]">RAG</dt>
                <dd className="font-semibold text-[#333333]">{config.useRag === false ? 'Off' : 'On'}</dd>
              </dl>
            ) : (
              <p className="mt-2 text-xs leading-5 text-[#666666]">
                Routing was not recorded for this earlier run. Its prompt and documents remain reusable.
              </p>
            )}
          </section>
        </div>
          </div>
        </div>
      </details>
    </section>
  )
}
