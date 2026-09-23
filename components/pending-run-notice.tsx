'use client'

import { useServiceHealth } from '@/components/service-health'

export function PendingRunNotice() {
  const health = useServiceHealth()
  const workerDown = health?.worker?.status === 'down' || health?.services.worker === 'down'

  if (!health) {
    return (
      <div className="ledger-panel px-4 py-4 text-sm text-[#666666]">
        Analysis is queued until pipeline-worker claims it. Refreshing this page does not start the pipeline.
      </div>
    )
  }

  if (workerDown) {
    return (
      <div role="alert" className="ledger-panel px-4 py-4 text-sm text-[#7c2d12]">
        This analysis is queued, but pipeline-worker is not running. Start it with <code className="font-mono">pnpm dev</code> or <code className="font-mono">pnpm pipeline:worker</code>. Refreshing this page does not start the pipeline. You can Stop the queued run if you no longer want it.
      </div>
    )
  }

  return (
    <div className="ledger-panel px-4 py-4 text-sm text-[#666666]">
      Analysis is queued. pipeline-worker is running and will claim it shortly. Refreshing this page does not start the pipeline.
    </div>
  )
}
