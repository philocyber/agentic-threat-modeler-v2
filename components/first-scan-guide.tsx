'use client'

import Link from 'next/link'
import { useSyncExternalStore } from 'react'

const DISMISSAL_KEY = 'agentic-tm:first-scan-guide-dismissed'

const listeners = new Set<() => void>()

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function readDismissed(): boolean {
  return window.localStorage.getItem(DISMISSAL_KEY) === 'true'
}

// Server snapshot is "dismissed" so SSR renders nothing; the client store
// re-reads localStorage after hydration without a hydration mismatch.
function readDismissedOnServer(): boolean {
  return true
}

export function FirstScanGuide() {
  const isDismissed = useSyncExternalStore(subscribe, readDismissed, readDismissedOnServer)

  function dismissGuide(): void {
    window.localStorage.setItem(DISMISSAL_KEY, 'true')
    listeners.forEach((callback) => callback())
  }

  if (isDismissed) return null

  return (
    <section className="ledger-panel overflow-hidden" aria-labelledby="first-scan-title">
      <div className="border-b ledger-rule px-5 py-4 sm:px-6">
        <p className="ledger-label">First scan guide</p>
        <h2 id="first-scan-title" className="mt-2 text-lg font-semibold text-[#111111]">
          Turn a system description into an actionable threat register
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#666666]">
          Start with the smallest useful context. Argus runs several threat-modeling
          methods, then consolidates the evidence into one reviewable result.
        </p>
      </div>
      <div className="grid divide-y divide-[#e9e3e5] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {[
          ['01', 'Choose a provider', 'Use Ollama locally or select a configured cloud provider.'],
          ['02', 'Add system context', 'Paste an RFC, a Mermaid diagram, or a concise architecture description.'],
          ['03', 'Review the register', 'Inspect priority, evidence, and mitigation guidance in one place.'],
        ].map(([number, title, detail]) => (
          <div key={number} className="px-5 py-5">
            <p className="font-mono text-xs font-bold text-[#111111]">{number}</p>
            <h3 className="mt-3 text-sm font-semibold text-[#111111]">{title}</h3>
            <p className="mt-2 text-xs leading-5 text-[#666666]">{detail}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#f1f1f0] px-5 py-4 sm:px-6">
        <p className="text-xs text-[#666666]">Most first scans take just a few minutes to configure.</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={dismissGuide}
            className="min-h-11 px-2 text-xs font-semibold text-[#666666] underline underline-offset-4 hover:text-[#111111]"
          >
            Don&apos;t show again
          </button>
          <Link
            href="/analyze"
            className="philo-primary-action inline-flex min-h-11 items-center px-4 text-sm"
          >
            Start your first scan
          </Link>
        </div>
      </div>
    </section>
  )
}
