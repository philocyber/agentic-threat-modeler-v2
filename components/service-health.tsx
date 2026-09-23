'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { HealthStatus } from '@/lib/models/types'
import type { RagHealth } from '@/lib/health/rag-status'

export function useServiceHealth(intervalMs = 20_000): HealthStatus | null {
  const [health, setHealth] = useState<HealthStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/v1/health', { cache: 'no-store' })
        const body = (await res.json()) as HealthStatus
        if (!cancelled) setHealth(body)
      } catch {
        if (!cancelled) {
          setHealth({
            status: 'error',
            services: {
              database: 'down',
              ollama: 'not_configured',
              chromadb: 'down',
              gemini: 'not_configured',
              kimi: 'not_configured',
              bedrock: 'not_configured',
              cursor: 'not_configured',
              worker: 'down',
            },
            timestamp: new Date().toISOString(),
          })
        }
      }
    }
    void load()
    const id = window.setInterval(() => void load(), intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [intervalMs])

  return health
}

function statusLabel(health: HealthStatus | null): { text: string; tone: 'ready' | 'degraded' | 'error' | 'loading' } {
  if (!health) return { text: 'Checking services', tone: 'loading' }
  if (health.status === 'error') return { text: 'Services down', tone: 'error' }
  if (health.worker?.compatible === false) return { text: 'Worker incompatible', tone: 'degraded' }
  if (health.worker?.status === 'down' || health.services.worker === 'down') return { text: 'Pipeline worker down', tone: 'degraded' }
  if (health.ollamaModels && !health.ollamaModels.ready) return { text: health.ollamaModels.reachable ? 'Local models missing' : 'Ollama unavailable', tone: 'degraded' }
  if (health.ragDefaultEnabled !== false && health.rag?.issue === 'index_building') return { text: 'RAG indexing', tone: 'loading' }
  if (health.ragDefaultEnabled !== false && health.rag && !health.rag.usable) return { text: 'RAG not ready', tone: 'degraded' }
  if (health.status === 'degraded' || (health.ragDefaultEnabled !== false && health.rag?.warning)) return { text: 'Services degraded', tone: 'degraded' }
  return { text: 'Services ready', tone: 'ready' }
}

function ragDetail(rag: RagHealth) {
  return (
    <>
      <p className="mt-2 text-xs leading-5 text-[#555555]">{rag.warning ?? rag.reason}</p>
      {rag.status === 'down' ? (
        <p className="mt-2 text-xs leading-5 text-[#555555]">
          Next.js being up does not start Chroma. Knowledge retrieval is a separate process on port 8000.
        </p>
      ) : null}
      {rag.recovery.length > 0 ? (
        <ol className="mt-3 list-decimal space-y-1.5 pl-4 text-xs leading-5 text-[#333333]">
          {rag.recovery.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
      <p className="mt-3 font-mono text-xs uppercase tracking-[0.08em] text-[#666666]">
        Chroma {rag.status}
        {rag.documentCount != null ? ` · ${rag.documentCount} docs` : ''}
        {` · ${rag.pageIndexNodes} page nodes`}
      </p>
    </>
  )
}

export function ServiceHealthIndicator() {
  const health = useServiceHealth()
  const [open, setOpen] = useState(false)
  const label = statusLabel(health)
  const rag = health?.rag
  const ragAttention = health?.ragDefaultEnabled !== false && Boolean(rag && (!rag.usable || rag.warning))
  const dotClass =
    label.tone === 'ready'
      ? 'bg-[#555555]'
      : label.tone === 'degraded'
        ? 'bg-[#f96715]'
        : label.tone === 'error'
          ? 'bg-[#dd2b37]'
          : 'bg-[#cacac7]'

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        className="flex min-h-9 items-center gap-2 px-1 text-xs font-medium text-[#666666] hover:text-[#111111]"
        aria-label={label.text}
        aria-expanded={open}
        aria-controls="service-health-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
        <span className="hidden sm:inline">{label.text}</span>
      </button>
      {open && (
        <div
          id="service-health-panel"
          role="status"
          className="absolute right-0 top-full z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] border border-[#cacac7] bg-white p-4 text-left shadow-[0_10px_28px_rgba(44,40,43,0.12)]"
        >
          <p className="text-sm font-semibold text-[#111111]">{label.text}</p>
          {health?.worker?.compatible === false ? (
            <p className="mt-2 text-xs leading-5 text-[#555555]">
              The live pipeline worker is running older code. {health.worker.recovery?.[0] ?? 'Restart the worker from this checkout before starting a new analysis.'}
            </p>
          ) : health?.worker?.status === 'down' || health?.services.worker === 'down' ? (
            <p className="mt-2 text-xs leading-5 text-[#555555]">
              Next.js can be healthy while pipeline-worker is not running. Analyses stay pending until you start it with pnpm dev or pnpm pipeline:worker.
            </p>
          ) : health?.ollamaModels && !health.ollamaModels.ready ? (
            <p className="mt-2 text-xs leading-5 text-[#555555]">
              {health.ollamaModels.reachable
                ? `Configured models are not installed: ${health.ollamaModels.missingModels.join(', ')}. Select an installed model in Run analysis or install the configured models.`
                : 'Start the configured Ollama service before running an analysis.'}
            </p>
          ) : ragAttention && rag ? (
            ragDetail(rag)
          ) : (
            <>
              <p className="mt-2 text-xs leading-5 text-[#555555]">
                {health?.ragDefaultEnabled === false
                  ? 'The app and pipeline worker are ready. Cloud inference is selected; knowledge retrieval is off by default and needs local Ollama embeddings if enabled.'
                  : 'Database, the selected LLM provider, pipeline-worker, and Chroma are reachable. Analyses can use knowledge retrieval.'}
              </p>
              <p className="mt-3 font-mono text-xs uppercase tracking-[0.08em] text-[#666666]">
                Chroma {health?.services.chromadb ?? 'unknown'}
                {rag?.documentCount != null ? ` · ${rag.documentCount} docs` : ''}
                {rag ? ` · ${rag.pageIndexNodes} page nodes` : ''}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function RagPreflightBanner({
  health,
  ragRequested,
  onTurnOffRag,
}: {
  health: HealthStatus | null
  ragRequested: boolean
  onTurnOffRag: () => void
}) {
  const rag = health?.rag
  if (!ragRequested && health?.ragDefaultEnabled === false) return null
  if (!rag) return null
  const blocking = !rag.usable
  const warningOnly = rag.usable && Boolean(rag.warning)
  if (!blocking && !warningOnly) return null

  return (
    <div
      role={blocking ? 'alert' : 'status'}
      className={
        blocking
          ? 'border border-[#f5c19b] bg-[#fff4ec] px-4 py-3 text-sm leading-6 text-[#7c2d12]'
          : 'border border-[#cacac7] bg-[#f1f1f0] px-4 py-3 text-sm leading-6 text-[#5d4620]'
      }
    >
      <p>
        <strong className="text-[#111111]">
          {blocking ? 'Knowledge retrieval is not ready.' : 'Knowledge retrieval is degraded.'}
        </strong>{' '}
        {rag.warning ?? rag.reason}
      </p>
      {rag.status === 'down' ? (
        <p className="mt-2 text-xs leading-5">
          The app can be healthy while Chroma is not running — they are separate processes.
        </p>
      ) : null}
      <p className="mt-2 text-xs font-bold uppercase tracking-[0.08em] text-[#9a3412]">
        {blocking ? 'Fix this before the scan' : 'Index before expecting vector evidence'}
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-5">
        {rag.recovery.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="mt-3 text-xs leading-5">
        <Link href="/knowledge" className="font-semibold underline decoration-[#cacac7] underline-offset-2 hover:text-[#111111]">
          Open Knowledge
        </Link>
        {' '}to index the corpus after Chroma is up.
      </p>
      {blocking && ragRequested ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs leading-5">
          <p className="max-w-xl">
            This form will not start an analysis with RAG on until retrieval is actually usable.
          </p>
          <button
            type="button"
            onClick={onTurnOffRag}
            className="min-h-9 border border-[#cacac7] bg-white px-3 text-xs font-semibold text-[#333333] hover:bg-[#fcfcfb]"
          >
            Run without RAG
          </button>
        </div>
      ) : blocking ? (
        <p className="mt-3 text-xs leading-5 text-[#555555]">
          RAG is off for this run. Start Chroma, index Knowledge, and turn RAG back on if you want knowledge-backed evidence.
        </p>
      ) : null}
    </div>
  )
}
