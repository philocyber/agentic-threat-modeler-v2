import { isProviderBillingError, telemetryHasBillingFailure } from '@/lib/llm/provider-errors'
import Link from 'next/link'
import { headers } from 'next/headers'
import { ThreatTable } from '@/components/threat-table'
import { MarkdownViewer } from '@/components/markdown-viewer'
import { ArchitectureViewer } from '@/components/architecture-viewer'
import { mapRowToUnifiedThreat } from '@/lib/db/helpers'
import { AnalysisProgress } from '@/components/analysis-progress'
import { generateMarkdownFromDB } from '@/lib/agents/report-generator'
import type { AnalysisConfig, ArchitectureData, UnifiedThreat } from '@/lib/models/types'
import { getThreatModel, listThreats } from '@/lib/storage/threat-models'
import { ThreatDiffPanel } from '@/components/threat-diff-panel'
import { RerunLink } from '@/components/rerun-link'
import { RunAgainButton } from '@/components/run-again-button'
import {
  readFinalReportArtifact,
  readFinalThreatsArtifact,
  readPhaseCheckpoints,
  resumableCheckpointPhases,
} from '@/lib/workspace/run-artifacts'
import { DebateByFinding } from '@/components/debate-by-finding'
import { getSystem, listSystemRuns } from '@/lib/storage/systems'
import { resolveRequestWorkspace } from '@/lib/workspace/request'
import { runWithWorkspace } from '@/lib/workspace/context'
import { NextRequest } from 'next/server'
import { readWorkspaceText } from '@/lib/workspace/artifacts'
import type { RAGTraceSnapshot } from '@/lib/rag/trace'
import { RAGInspector } from '@/components/rag-inspector'
import { RunInputsPanel } from '@/components/run-inputs-panel'
import { RunTelemetryWindow } from '@/components/run-telemetry'
import { fingerprintSystemName, inferSourceInput, type RunInputBundle } from '@/lib/runs/input-bundle'
import { RunTitleEditor } from '@/components/run-title-editor'
import { formatRuntime } from '@/lib/ui/format'
import { loadResumeLineageForRun } from '@/lib/runs/load-resume-lineage'
import { isTerminalAnalysisStatus } from '@/lib/models/analysis-status'
import { resolveResultThreats } from '@/lib/runs/result-threats'
import { ResultsWorkspaceTabs, type ResultWorkspaceTab } from '@/components/results-workspace-tabs'
import { reviewCounts } from '@/lib/ui/review-queue'
import summaryStyles from './review-summary.module.css'
import resultStyles from './results-v2.module.css'

type ResultPageProps = {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ finding?: string | string[]; section?: string | string[] }>
}

const PRIORITY_STAT = [
  { key: 'critical', label: 'Critical' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
] as const

export default async function ResultPage({ params, searchParams }: ResultPageProps) {
  const { id } = await params
  const query = await searchParams
  const requestedFinding = typeof query?.finding === 'string' ? query.finding : undefined
  const requestHeaders = await headers()
  const workspace = await resolveRequestWorkspace(
    new NextRequest('http://localhost/results', { headers: requestHeaders }),
  )
  const threatModel = workspace
    ? await runWithWorkspace(workspace, () => getThreatModel(id))
    : await getThreatModel(id)

  if (!threatModel) {
    return (
      <div className="text-center py-24">
        <p className="text-5xl font-bold text-slate-200">404</p>
        <p className="text-slate-500 mt-3">Threat model not found</p>
        <Link href="/" className="inline-block mt-5 text-primary text-sm hover:underline">
          ← Back to Dashboard
        </Link>
      </div>
    )
  }

  const threatsList = workspace
    ? await runWithWorkspace(workspace, () => listThreats(id))
    : await listThreats(id)
  const databaseThreats = threatsList.map(mapRowToUnifiedThreat)
  let ragTrace: RAGTraceSnapshot | null = null
  let artifactConfig: AnalysisConfig | null = null
  let artifactSystemName: string | undefined
  let artifactThreats: UnifiedThreat[] = []
  let artifactReport: string | null = null
  let billingBlocked = isProviderBillingError(threatModel.errorMessage) || (threatModel.pipelineErrors as string[] | null)?.some(isProviderBillingError) || false
  if (workspace) {
    const [ragResult, manifestResult, threatsArtifactResult, reportArtifactResult, telemetryResult] = await Promise.allSettled([
      readWorkspaceText(workspace, `runs/${id}/rag-trace.json`),
      readWorkspaceText(workspace, `runs/${id}/run.json`),
      runWithWorkspace(workspace, () => readFinalThreatsArtifact(id)),
      runWithWorkspace(workspace, () => readFinalReportArtifact(id)),
      threatModel.status === 'partial' && !billingBlocked
        ? readWorkspaceText(workspace, `runs/${id}/telemetry.jsonl`)
        : Promise.resolve(''),
    ])
    if (telemetryResult.status === 'fulfilled') billingBlocked ||= telemetryHasBillingFailure(telemetryResult.value)
    if (ragResult.status === 'fulfilled') {
      try {
        ragTrace = JSON.parse(ragResult.value) as RAGTraceSnapshot
      } catch {
        ragTrace = null
      }
    }
    if (manifestResult.status === 'fulfilled') {
      try {
        const manifest = JSON.parse(manifestResult.value) as { config?: AnalysisConfig; systemName?: string }
        artifactConfig = manifest.config ?? null
        artifactSystemName = manifest.systemName
      } catch {
        artifactConfig = null
      }
    }
    if (threatsArtifactResult.status === 'fulfilled') {
      artifactThreats = threatsArtifactResult.value ?? []
    }
    if (reportArtifactResult.status === 'fulfilled') {
      artifactReport = reportArtifactResult.value
    }
  }

  const { threats: unifiedThreats, source: threatSource } = resolveResultThreats(databaseThreats, artifactThreats)

  const lineage = workspace
    ? await runWithWorkspace(workspace, () =>
        loadResumeLineageForRun({
          workspace,
          runId: id,
          ...(threatModel.metadata?.resumeFrom ? { metadataResumeFrom: threatModel.metadata.resumeFrom } : {}),
          thisRunSeconds: threatModel.executionTimeSeconds,
          thisRunTokens: threatModel.llmTokensUsed,
        }),
      )
    : await loadResumeLineageForRun({
        workspace: null,
        runId: id,
        ...(threatModel.metadata?.resumeFrom ? { metadataResumeFrom: threatModel.metadata.resumeFrom } : {}),
        thisRunSeconds: threatModel.executionTimeSeconds,
        thisRunTokens: threatModel.llmTokensUsed,
      })
  // A resume attempt records only work performed in that attempt. Summing the
  // direct parent made a multi-hop lineage look like a full end-to-end runtime
  // even though earlier ancestors were omitted.
  const displayRuntimeSeconds = threatModel.executionTimeSeconds
  const displayTokens = threatModel.llmTokensUsed

  // Only offer a resume when there is something banked to reuse.
  const checkpoints = workspace
    ? await runWithWorkspace(workspace, () => readPhaseCheckpoints(id))
    : null
  const reusablePhases = checkpoints ? resumableCheckpointPhases(checkpoints).length : 0

  const system = threatModel.systemId
    ? (workspace
        ? await runWithWorkspace(workspace, () => getSystem(threatModel.systemId!))
        : await getSystem(threatModel.systemId!))
    : null
  const siblingRuns = threatModel.systemId
    ? (workspace
        ? await runWithWorkspace(workspace, () => listSystemRuns(threatModel.systemId!))
        : await listSystemRuns(threatModel.systemId!))
    : []
  const supportingDocuments = threatModel.supportingDocuments ?? []
  const runInputBundle: RunInputBundle = {
    schemaVersion: 1,
    runId: id,
    systemName: fingerprintSystemName(artifactSystemName, threatModel.title),
    systemId: threatModel.systemId ?? null,
    sourceInput: inferSourceInput(threatModel.input, supportingDocuments),
    effectiveInput: threatModel.input,
    inputType: threatModel.metadata?.input_type ?? 'text',
    supportingDocuments,
    executionConfig: threatModel.metadata?.analysis_config ?? artifactConfig,
    versionHash: threatModel.versionHash,
  }
  // `partial` runs lost a phase but still carry real findings: they render the
  // same workbench as a clean run, with the degradation banner above it.
  const hasResults = threatModel.status === 'completed' || threatModel.status === 'partial'
  const isTerminal = isTerminalAnalysisStatus(threatModel.status)
  const canResume = (threatModel.status === 'partial' || threatModel.status === 'failed') && reusablePhases > 0
  const architecture = threatModel.architectureJson as ArchitectureData | null
  const queueCounts = reviewCounts(unifiedThreats)
  const highCriticalCount = unifiedThreats.filter((threat) => threat.scoringStatus !== 'unscored' && (threat.priority === 'high' || threat.priority === 'critical')).length
  const unscoredCount = unifiedThreats.filter((threat) => threat.scoringStatus === 'unscored').length
  const sourceEvidence = architecture?.sourceEvidence
  const sourceExtractionOk = Boolean(sourceEvidence?.sections.length && sourceEvidence.extraction.failed.length === 0 && threatModel.status === 'completed')
  const generatedReport = artifactReport ?? generateMarkdownFromDB({ threatModel, threats: threatsList })
  const flowHeading = generatedReport.search(/^## Data Flow Diagram\s*$/m)
  const threatSummaryHeading = generatedReport.search(/^## Threat Summary\s*$/m)
  const debateHeading = generatedReport.search(/^## Red Team \/ Blue Team Debate\s*$/m)
  const architectureHeading = generatedReport.search(/^## Architecture Details\s*$/m)
  const reportMainEnd = debateHeading >= 0 ? debateHeading : architectureHeading >= 0 ? architectureHeading : generatedReport.length
  const reportHasFlowAppendix = flowHeading >= 0 && threatSummaryHeading > flowHeading && threatSummaryHeading < reportMainEnd
  const reportMain = reportHasFlowAppendix
    ? `${generatedReport.slice(0, flowHeading)}\n${generatedReport.slice(threatSummaryHeading, reportMainEnd)}`
    : generatedReport.slice(0, reportMainEnd)
  const reportDebate = debateHeading >= 0 ? generatedReport.slice(debateHeading, architectureHeading > debateHeading ? architectureHeading : undefined) : ''
  const reportArchitecture = `${reportHasFlowAppendix ? `${generatedReport.slice(flowHeading, threatSummaryHeading)}\n` : ''}${architectureHeading >= 0 ? generatedReport.slice(architectureHeading) : ''}`
  const resultTabs: ResultWorkspaceTab[] = hasResults ? [
    {
      id: 'findings',
      label: 'Findings',
      badge: unifiedThreats.length,
      content: unifiedThreats.length > 0 ? (
        <div className="space-y-4">
          {threatSource === 'artifact' ? (
            <div className="flex flex-wrap items-start justify-between gap-3 border border-[#e3cf91] bg-[#fff8df] px-4 py-3 text-sm text-[#5f4300]">
              <div><p className="font-semibold">Recovered from the verified run snapshot</p><p className="mt-1 text-xs leading-5">The full findings remain available for browsing. Reviewer decisions are read-only because this historical run has no relational review records.</p></div>
              <span className="border border-[#d8b54e] bg-white px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide">Artifact-backed</span>
            </div>
          ) : null}
          {unifiedThreats.some(threat => !threat.scoringStatus) && <p className="border border-[#e3cf91] bg-[#fff8df] px-4 py-3 text-sm text-[#5f4300]">This historical run retains its original assessment. Run again to reassess its evidence, system scope, and scores with the updated analysis.</p>}
          <section className="workbench-panel overflow-hidden" aria-labelledby="finding-overview-title">
            <h2 id="finding-overview-title" className="sr-only">Finding review summary</h2>
            <dl className={summaryStyles.metrics ?? ''}>
              <div><dt>Pending review</dt><dd>{queueCounts.pending}</dd></div>
              <div><dt>High / Critical severity</dt><dd>{highCriticalCount}</dd></div>
              <div><dt>Need verification</dt><dd>{queueCounts.verify}</dd></div>
              <div><dt>Reviewed</dt><dd>{queueCounts.reviewed}</dd></div>
            </dl>
            <div className={summaryStyles.summaryDetails}>
              <div className={summaryStyles.severityGroup}>
                <span className={summaryStyles.detailLabel}>Severity breakdown</span>
                <dl className={summaryStyles.severities}>
                  {PRIORITY_STAT.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{unifiedThreats.filter((threat) => threat.scoringStatus !== 'unscored' && threat.priority === key).length}</dd></div>)}
                </dl>
                {unscoredCount > 0 && <p className={summaryStyles.scoringNote}>{unscoredCount} unscored findings excluded</p>}
              </div>
              <p className={summaryStyles.sourceNote} data-state={sourceExtractionOk ? 'ok' : 'warning'}>
                <span aria-hidden="true">{sourceExtractionOk ? '✓' : '!'}</span>
                <span>{sourceEvidence ? `${sourceEvidence.sections.length} source sections retained · ${sourceEvidence.extraction.failed.length} extraction failures` : 'Source delivery detail unavailable'}<small>Delivery is not exhaustive coverage.{threatModel.status === 'partial' ? ' Partial run: inspect warnings.' : ''}</small></span>
              </p>
            </div>
            <p className={summaryStyles.readiness}><strong>{highCriticalCount} High/Critical by severity; {queueCounts.actionable} ready to decide.</strong> Readiness also requires a validated score, an applicable scenario, and a verified source quotation. Check unresolved preconditions and controls.</p>
          </section>
          <ThreatTable
            key={`${id}-${requestedFinding ?? 'default'}`}
            initialSelectedThreatId={requestedFinding}
            threats={unifiedThreats}
            debateSummary={threatModel.debateSummary}
            {...(threatSource === 'database' ? { analysisId: id } : {})}
          />
        </div>
      ) : (
        <EmptyResultSection
          title={threatModel.status === 'failed'
            ? 'Analysis did not complete'
            : threatModel.totalThreats
              ? 'Finding snapshot unavailable'
              : 'Completed with no architecture-supported threats'}
          copy={threatModel.status === 'failed'
            ? (threatModel.errorMessage ?? 'The pipeline stopped before producing findings. This is not a conclusion of zero threats.')
            : threatModel.totalThreats
              ? 'This run records a finding total, but neither relational rows nor a verified findings snapshot are available.'
              : 'The pipeline finished every required stage and did not emit an architecture-supported candidate.'}
        />
      ),
    },
    {
      id: 'architecture',
      label: 'Architecture',
      ...(architecture?.components ? { badge: architecture.components.length } : {}),
      content: architecture ? (
        <section className="workbench-panel overflow-hidden" aria-labelledby="architecture-tab-title"><div className="border-b border-[#e4e4e2] px-5 py-4"><h2 id="architecture-tab-title" className="workbench-heading text-lg">Threat architecture</h2><p className="mt-1 text-sm text-[#666666]">Browse system boundaries, components, data paths, controls, and linked findings.</p></div><div className="bg-white p-5"><ArchitectureViewer architecture={architecture} threats={unifiedThreats} analysisId={id} /></div></section>
      ) : <EmptyResultSection title="Architecture unavailable" copy="This run did not preserve a structured architecture snapshot." />,
    },
    {
      id: 'debate',
      label: 'Red / Blue debate',
      content: threatModel.debateSummary ? (
        <section className="workbench-panel p-5"><DebateByFinding summary={threatModel.debateSummary} threats={unifiedThreats} analysisId={id} /></section>
      ) : <EmptyResultSection title="No debate record" copy="This run did not preserve an adversarial validation transcript." />,
    },
    {
      id: 'report',
      label: 'Report',
      content: (
        <section className={`${resultStyles.report} workbench-panel overflow-hidden`} aria-labelledby="report-tab-title">
          <div className={resultStyles.reportHero}>
            <div className={resultStyles.reportHeroCopy}>
              <p className={resultStyles.reportEyebrow}>Assessment record / 04</p>
              <h2 id="report-tab-title" className="workbench-heading">A report built for decisions.</h2>
              <p>Read the assessment here, then take a portable copy with the same findings and source caveats. Reviewer decisions still belong in the findings workspace.</p>
              <div className={resultStyles.reportActions}>
                {hasResults ? <a className={resultStyles.reportDownload} href={`/api/v1/results/${id}?format=pdf`} download>↓ Download {queueCounts.pending > 0 || threatModel.status === 'partial' ? 'draft ' : ''}PDF</a> : null}
                <Link href={`/results/${id}?section=findings`} className={resultStyles.reportReviewLink}>Review findings →</Link>
              </div>
            </div>
            <div className={resultStyles.reportEdition}><span>REPORT / REVIEW COPY</span><strong>{queueCounts.pending > 0 || threatModel.status === 'partial' ? 'Draft' : 'Reviewed run'}</strong><small>{threatModel.status === 'partial' ? 'Partial analysis' : `${queueCounts.pending} decisions pending`}</small></div>
          </div>
          <div className={`${resultStyles.reportMetrics} grid gap-3 border-b border-[#e4e4e2] bg-[#fcfcfb] p-5 text-sm sm:grid-cols-3`}><div><p className="text-[10px] font-bold uppercase tracking-wide text-[#666666]">Findings</p><p className="mt-1 font-mono text-xl font-bold">{unifiedThreats.length}</p></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-[#666666]">High / Critical</p><p className="mt-1 font-mono text-xl font-bold">{unifiedThreats.filter((threat) => threat.scoringStatus !== 'unscored' && (threat.priority === 'high' || threat.priority === 'critical')).length}</p></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-[#666666]">Awaiting review</p><p className="mt-1 font-mono text-xl font-bold">{queueCounts.pending}</p></div><p className="text-xs leading-5 text-[#666666] sm:col-span-3">Severity describes the scenario; it does not establish applicability or exploitability. {threatModel.status === 'partial' ? 'This run is partial. ' : ''}Source delivery is not exhaustive coverage. <Link href={`/results/${id}?section=findings`} className="font-semibold underline">Open review queue →</Link></p></div>
          <div className={resultStyles.reportReading}><div className={resultStyles.reportReadingLabel}><span>THE ASSESSMENT</span><span>Read online / export above</span></div><div className={resultStyles.reportBody}><MarkdownViewer content={reportMain} /></div></div>
          {reportDebate || reportArchitecture ? <div className={resultStyles.reportAppendices}>
            <p>SUPPORTING RECORD</p>
            {reportDebate ? <details><summary>Red / Blue debate transcript <span>Open full analysis →</span></summary><div className={resultStyles.reportBody}><MarkdownViewer content={reportDebate} /></div></details> : null}
            {reportArchitecture ? <details><summary>Architecture source details <span>Open source inventory →</span></summary><div className={resultStyles.reportBody}><MarkdownViewer content={reportArchitecture} /></div></details> : null}
          </div> : null}
        </section>
      ),
    },
    {
      id: 'run',
      label: 'Run details',
      content: (
        <div className="space-y-4">
          <section className="workbench-panel overflow-hidden" aria-label="Recorded run telemetry"><RunTelemetryWindow analysisId={id} live={false} /></section>
          <RunInputsPanel bundle={runInputBundle} live={false} showTelemetry={false} />
          <section className="workbench-panel overflow-hidden" aria-labelledby="rag-tab-title"><div className="border-b border-[#e4e4e2] px-5 py-4"><h2 id="rag-tab-title" className="workbench-heading text-lg">RAG Inspector</h2><p className="mt-1 text-sm text-[#666666]">Retrieval plan, selected sources, context budget, and validation audit trail.</p></div><RAGInspector trace={ragTrace} /></section>
        </div>
      ),
    },
  ] : []

  return (
    <div className={`${resultStyles.page} space-y-4`}>
      {/* Breadcrumb + header */}
      <div className={resultStyles.header}>
        <div>
          <Link href="/" className={resultStyles.backLink}>
            ← Analysis register
          </Link>
          <p className={resultStyles.eyebrow}>Analysis workspace / Review</p>
          <h1 className="mt-1 min-w-0">
            <RunTitleEditor
              analysisId={id}
              systemName={threatModel.title ?? ''}
              appearance="heading"
            />
          </h1>
          <div className={resultStyles.headerMeta}>
            {threatModel.metadata?.demo === true && <span className="border border-[#9daca5] bg-[#eef5f0] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-[#315b4a]">Demo</span>}
            <span className="flex items-center gap-2 pr-4 font-semibold uppercase tracking-[0.11em] text-[#315b4a]">
              <span className={`h-2 w-2 rounded-full ${threatModel.status === 'completed' ? 'bg-[#555555]' : threatModel.status === 'failed' ? 'bg-red-500' : 'bg-amber-500'}`} />
              {threatModel.cancelRequestedAt ? 'Stopped' : threatModel.status}
            </span>
            {system && system.name !== threatModel.title && (
              <span className="px-4"><span className="mr-1.5 uppercase tracking-[0.1em] text-[#666666]">System</span><strong className="font-semibold text-[#444444]">{system.name}</strong></span>
            )}
            {threatModel.totalThreats != null && (
              <span className="px-4"><strong className="font-semibold text-[#333333]">{threatModel.totalThreats}</strong> findings</span>
            )}
            {threatModel.filteredThreats != null && threatModel.filteredThreats > 0 && (
              <span className="px-4 text-amber-700"><strong className="font-semibold">{threatModel.filteredThreats}</strong> filtered</span>
            )}
            {!threatModel.cancelRequestedAt && (threatModel.pipelineErrors as string[] | null)?.length ? (
              <span className="px-4 font-semibold text-amber-700">{(threatModel.pipelineErrors as string[]).length} pipeline warning(s)</span>
            ) : null}
          </div>
          {lineage ? (
            <p className="mt-2 max-w-2xl text-xs leading-5 text-[#666666]">
              Resumed from{' '}
              <Link href={`/results/${lineage.resumeFrom}`} className="font-medium text-[#111111] underline-offset-2 hover:underline">
                a prior attempt
              </Link>
              {lineage.reusedPhases > 0 ? ` · ${lineage.reusedPhases} stages reused` : ''}
              {lineage.thisRunSeconds > 0
                ? ` · ${formatRuntime(lineage.thisRunSeconds)} this attempt (overlay and remaining stages only)`
                : ''}
            </p>
          ) : null}
        </div>

        <details className={`${resultStyles.tools} run-tools-menu`}><summary className="inline-flex min-h-9 cursor-pointer items-center border border-[#cacac7] px-2 text-xs font-semibold sm:min-h-10 sm:px-3"><span className="sm:hidden">Run tools</span><span className="hidden sm:inline">Run tools and exports</span></summary><div className="absolute right-0 z-40 mt-1 w-52 space-y-2 border border-[#cacac7] bg-white p-3 shadow-xl">
        {isTerminal ? (
          <RunAgainButton
            runId={id}
            mode={canResume ? 'resume' : 'fresh'}
            label={canResume ? 'Resume analysis' : 'Run again'}
            className="inline-flex min-h-10 items-center gap-2 rounded-sm bg-[#111111] px-4 text-xs font-semibold text-white transition-colors hover:bg-[#333333] disabled:cursor-wait disabled:opacity-60"
          />
        ) : null}
        {hasResults && (
          <div className="flex flex-col gap-2">
            {(queueCounts.pending > 0 || threatModel.status === 'partial') && <p className="text-xs text-amber-800">Draft outputs: reviews pending or run partial</p>}
            <a
              href={`/api/v1/results/${id}?format=pdf`}
              className="inline-flex items-center gap-1.5 rounded-sm bg-[#111111] px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#333333]"
              download
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 2h9l4 4v16H6zM14 2v5h5M9 13h6M9 17h4" />
              </svg>
              PDF report
            </a>
            <a
              href={`/api/v1/results/${id}?format=csv`}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-sm border border-slate-300 text-slate-700 text-xs font-medium hover:bg-slate-50 transition-colors"
              download
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              CSV
            </a>
            <a
              href={`/api/v1/results/${id}?format=markdown`}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-sm border border-slate-300 text-slate-700 text-xs font-medium hover:bg-slate-50 transition-colors"
              download
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Markdown
            </a>
          </div>
        )}
        <p className="border-t border-[#e4e4e2] pt-2 text-[11px] text-[#666666]">Runtime: {displayRuntimeSeconds != null ? formatRuntime(displayRuntimeSeconds) : 'in progress'} · Tokens: {displayTokens?.toLocaleString() ?? '—'}</p>
        </div></details>
      </div>

      {/* Queued and running analyses both need live progress. */}
      {(threatModel.status === 'pending' || threatModel.status === 'running') && (
        <AnalysisProgress
          analysisId={id}
          enabledAnalysts={runInputBundle.executionConfig?.enabledAnalysts}
        />
      )}

      {billingBlocked && !threatModel.cancelRequestedAt && (
        <div role="alert" className="rounded-sm border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Model provider billing blocked this run</p>
          <p className="mt-1">The provider reported insufficient balance or billing quota. Restore provider billing before resuming. Completed outputs are preserved; unfinished debate and scoring are incomplete.</p>
        </div>
      )}

      {!threatModel.cancelRequestedAt && (threatModel.pipelineErrors as string[] | null)?.length ? (
        <div className="rounded-sm border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold mb-1">{billingBlocked ? 'Stages affected by the billing failure' : 'Partial pipeline failures'}</p>
          <ul className="list-disc pl-5 space-y-0.5 text-xs">
            {(threatModel.pipelineErrors as string[]).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {hasResults && siblingRuns.length > 1 && (
        <ThreatDiffPanel runId={id} siblingRuns={siblingRuns} />
      )}

      {/* Failed / stopped */}
      {threatModel.status === 'failed' && (
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 rounded-sm bg-red-50 border border-red-200 text-sm text-red-700">
          <div className="flex items-start gap-3">
            <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
            <span>
              {threatModel.cancelRequestedAt ? 'Analysis stopped by user.' : `Analysis failed: ${threatModel.errorMessage ?? 'Unknown error'}`}
            </span>
          </div>
          <RerunLink
            systemName={runInputBundle.systemName}
            systemId={threatModel.systemId}
            rerunFrom={id}
            className="inline-flex min-h-10 items-center border border-red-300 bg-white px-4 text-xs font-semibold text-red-800 hover:bg-red-100"
          >
            Edit inputs before rerun
          </RerunLink>
          <Link href="/docs" className="text-xs font-semibold underline">Troubleshooting guidance</Link>
        </div>
      )}

      {!hasResults && (
        <RunInputsPanel
          bundle={runInputBundle}
          live={threatModel.status === 'running' || threatModel.status === 'pending'}
        />
      )}

      {hasResults ? <ResultsWorkspaceTabs tabs={resultTabs} /> : null}
    </div>
  )
}

function EmptyResultSection({ title, copy }: { title: string; copy: string }) {
  return (
    <section className="workbench-panel px-5 py-14 text-center">
      <p className="text-lg font-semibold text-[#111111]">{title}</p>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[#666666]">{copy}</p>
    </section>
  )
}
