import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="ledger-panel w-full max-w-lg p-6 text-center">
        <p className="font-mono text-4xl font-semibold tracking-tight text-[#f96715]">404</p>
        <p className="ledger-label mt-4">Entry not found</p>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-[#111111]">
          This page is not in the register
        </h1>
        <p className="mt-2 text-sm leading-6 text-[#666666]">
          The page you are looking for does not exist or may have been moved. Head back to the
          analysis register to keep working.
        </p>
        <div className="mt-6">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center bg-[#111111] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#333333]"
          >
            Back to analyses
          </Link>
        </div>
      </div>
    </div>
  )
}
