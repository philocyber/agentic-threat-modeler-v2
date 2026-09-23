'use client'

import { useEffect } from 'react'
import Link from 'next/link'

export default function Error({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  reset?: () => void
  unstable_retry?: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  const retry = unstable_retry ?? reset

  return (
    <div className="flex items-center justify-center py-20">
      <div className="ledger-panel w-full max-w-lg p-6 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center border border-[#e4e4e2] bg-[#f1f0eb]">
          <svg aria-hidden="true" className="h-6 w-6 text-[#a55a13]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>
        <p className="ledger-label">Workspace error</p>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-[#111111]">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm leading-6 text-[#666666]">
          The register hit an unexpected problem while rendering this page. Your analyses and
          project data are safe — try reloading this view.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-xs text-[#666666]">
            Reference: {error.digest}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {retry && (
            <button
              type="button"
              onClick={() => retry()}
              className="inline-flex min-h-11 items-center bg-[#111111] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#333333]"
            >
              Try again
            </button>
          )}
          <Link
            href="/"
            className="inline-flex min-h-11 items-center border border-[#e4e4e2] bg-[#faf9f5] px-4 text-sm font-semibold text-[#111111] transition-colors hover:bg-[#f1f0eb]"
          >
            Back to analyses
          </Link>
        </div>
      </div>
    </div>
  )
}
