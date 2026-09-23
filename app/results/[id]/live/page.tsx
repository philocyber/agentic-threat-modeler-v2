import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { NextRequest } from 'next/server'
import { AnalysisProgress } from '@/components/analysis-progress'
import { RunTelemetryWindow } from '@/components/run-telemetry'
import { isTerminalAnalysisStatus } from '@/lib/models/analysis-status'
import { getThreatModel } from '@/lib/storage/threat-models'
import { runWithWorkspace } from '@/lib/workspace/context'
import { resolveRequestWorkspace } from '@/lib/workspace/request'

export default async function LiveAnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const requestHeaders = await headers()
  const workspace = await resolveRequestWorkspace(
    new NextRequest('http://localhost/results', { headers: requestHeaders }),
  )
  const threatModel = workspace
    ? await runWithWorkspace(workspace, () => getThreatModel(id))
    : await getThreatModel(id)

  if (!threatModel) notFound()
  if (isTerminalAnalysisStatus(threatModel.status)) redirect(`/results/${id}`)

  return (
    <main className="mx-auto max-w-6xl space-y-4 pb-12">
      <AnalysisProgress
        analysisId={id}
        systemName={threatModel.title ?? undefined}
        enabledAnalysts={threatModel.metadata?.analysis_config?.enabledAnalysts}
        completionHref={`/results/${id}`}
      />
      <section className="workbench-panel overflow-hidden rounded-2xl" aria-label="Live run telemetry">
        <RunTelemetryWindow analysisId={id} live defaultExpanded />
      </section>
    </main>
  )
}
