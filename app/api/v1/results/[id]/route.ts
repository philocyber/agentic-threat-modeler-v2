import { workspaceRoute } from '@/lib/local-route'
import {
  archiveThreatModel,
  getThreatModel,
  listThreats,
  permanentlyDeleteThreatModel,
  renameThreatModel,
  restoreThreatModel,
} from '@/lib/storage/threat-models'
import { mapRowToUnifiedThreat } from '@/lib/db/helpers'
import { generateCSV, generateMarkdownFromDB } from '@/lib/agents/report-generator'
import { safeExportFilename } from '@/lib/utils/csv'
import { buildArchitectureMermaid } from '@/lib/architecture/mermaid'
import type { AnalysisConfig, ArchitectureData } from '@/lib/models/types'
import {
  activeWorkspaceOrNull,
  readWorkspaceText,
  removeWorkspaceRunArtifacts,
} from '@/lib/workspace/artifacts'
import type { RAGTraceSnapshot } from '@/lib/rag/trace'
import { fingerprintSystemName, inferSourceInput, type RunInputBundle } from '@/lib/runs/input-bundle'
import { LifecycleActionRequestSchema, RenameAnalysisRequestSchema } from '@/lib/api/schemas'
import { generatePhiloCyberPdf } from '@/lib/reports/philocyber-pdf'
import { loadResumeLineageForRun } from '@/lib/runs/load-resume-lineage'
import { lineageRuntimeSeconds } from '@/lib/runs/resume-lineage'
import { logger } from '@/lib/logger'
import { readFinalReportArtifact, readFinalThreatsArtifact } from '@/lib/workspace/run-artifacts'
import { resolveResultThreats } from '@/lib/runs/result-threats'
import { evaluateThreatQuality } from '@/lib/evaluation/threat-quality'
import { describeRunExecution } from '@/lib/reports/execution-status'


export const GET = workspaceRoute(async (req, { params }) => {
  const { id } = params as { id: string }
  const format = req.nextUrl.searchParams.get('format')

  const threatModel = await getThreatModel(id)
  if (!threatModel) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }

  const supportingDocuments = threatModel.supportingDocuments ?? []
  let artifactConfig: AnalysisConfig | null = null
  let artifactSystemName: string | undefined
  const workspace = activeWorkspaceOrNull()
  if (workspace) {
    try {
      const manifest = JSON.parse(
        await readWorkspaceText(workspace, `runs/${id}/run.json`),
      ) as { config?: AnalysisConfig; systemName?: string }
      artifactConfig = manifest.config ?? null
      artifactSystemName = manifest.systemName
    } catch {
      artifactConfig = null
    }
  }

  const bundle: RunInputBundle = {
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

  if (format === 'inputs') {
    return Response.json(bundle, { headers: { 'Cache-Control': 'no-store' } })
  }

  const threatsList = await listThreats(id)
  const databaseThreats = threatsList.map(mapRowToUnifiedThreat)
  const artifactThreats = workspace ? await readFinalThreatsArtifact(id).catch(() => null) : null
  const artifactReport = workspace ? await readFinalReportArtifact(id).catch(() => null) : null
  const { threats: unifiedThreats } = resolveResultThreats(databaseThreats, artifactThreats)
  const isDraft = threatModel.status !== 'completed' || unifiedThreats.some((threat) => !threat.reviewStatus || threat.reviewStatus === 'pending')
  let ragInspector: RAGTraceSnapshot | null = threatModel.metadata?.rag_trace ?? null
  if (workspace) {
    try {
      ragInspector = JSON.parse(await readWorkspaceText(workspace, `runs/${id}/rag-trace.json`)) as RAGTraceSnapshot
    } catch {
      ragInspector = null
    }
  }

  if (format === 'csv') {
    const csv = generateCSV(unifiedThreats)
    const filename = safeExportFilename(threatModel.title ?? 'threats', 'threats')
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}-threats${isDraft ? '-draft' : ''}.csv"`,
        'X-Review-State': isDraft ? 'draft' : 'reviewed',
      },
    })
  }

  if (format === 'markdown') {
    const markdown = artifactReport ?? generateMarkdownFromDB({ threatModel, threats: threatsList })
    const filename = safeExportFilename(threatModel.title ?? 'threat-model', 'report')
    return new Response(isDraft ? `> **DRAFT:** Reviewer decisions are pending or this analysis is incomplete.\n\n${markdown}` : markdown, {
      headers: {
        'Content-Type': 'text/markdown',
        'Content-Disposition': `attachment; filename="${filename}${isDraft ? '-draft' : ''}.md"`,
        'X-Review-State': isDraft ? 'draft' : 'reviewed',
      },
    })
  }

  const lineage = await loadResumeLineageForRun({
    workspace,
    runId: id,
    ...(threatModel.metadata?.resumeFrom ? { metadataResumeFrom: threatModel.metadata.resumeFrom } : {}),
    thisRunSeconds: threatModel.executionTimeSeconds,
    thisRunTokens: threatModel.llmTokensUsed,
  })
  const durationSeconds =
    lineage && lineage.inheritedSeconds != null
      ? lineageRuntimeSeconds(lineage)
      : threatModel.executionTimeSeconds

  if (format === 'pdf') {
    const pdf = await generatePhiloCyberPdf({
      id,
      title: threatModel.title ?? id,
      status: threatModel.status,
      draft: isDraft,
      createdAt: threatModel.createdAt,
      completedAt: threatModel.completedAt,
      durationSeconds,
      systemDescription: threatModel.systemDescription,
      architecture: threatModel.architectureJson as ArchitectureData | null,
      threats: unifiedThreats,
      debateSummary: threatModel.debateSummary,
      ragTrace: ragInspector,
      inputBundle: bundle,
      pipelineErrors: threatModel.pipelineErrors ?? [],
      errorMessage: threatModel.errorMessage,
    })
    const filename = safeExportFilename(threatModel.title ?? 'threat-model', 'report')
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}${isDraft ? '-draft' : ''}.pdf"`,
        'X-Review-State': isDraft ? 'draft' : 'reviewed',
        'Cache-Control': 'no-store',
      },
    })
  }

  return Response.json({
    id: threatModel.id,
    systemName: threatModel.title,
    status: threatModel.status,
    threats: unifiedThreats,
    totalThreats: threatModel.totalThreats,
    filteredThreats: threatModel.filteredThreats,
    durationMs: durationSeconds ? durationSeconds * 1000 : null,
    markdownReport: artifactReport ?? generateMarkdownFromDB({ threatModel, threats: threatsList }),
    mermaidDfd: threatModel.architectureJson
      ? buildArchitectureMermaid(threatModel.architectureJson as ArchitectureData)
      : null,
    metadata: threatModel.metadata,
    versionHash: threatModel.versionHash,
    pipelineErrors: threatModel.pipelineErrors ?? [],
    execution: describeRunExecution({
      status: threatModel.status,
      errorMessage: threatModel.errorMessage,
      pipelineErrors: threatModel.pipelineErrors ?? [],
      threatCount: unifiedThreats.length,
    }),
    quality: evaluateThreatQuality(threatModel.architectureJson as ArchitectureData | null, unifiedThreats, threatModel.debateSummary ?? ''),
    currentPhase: threatModel.currentPhase,
    ragInspector,
    createdAt: threatModel.createdAt,
    completedAt: threatModel.completedAt,
    ...(threatModel.status === 'failed' && { errorMessage: threatModel.errorMessage }),
  })
})

export const PATCH = workspaceRoute(async (req, { params }) => {
  const { id } = params as { id: string }
  const body = await req.json().catch(() => null)
  const lifecycle = LifecycleActionRequestSchema.safeParse(body)
  const rename = RenameAnalysisRequestSchema.safeParse(body)
  if (!lifecycle.success && !rename.success) {
    return Response.json({ error: 'Request must include action or systemName' }, { status: 400 })
  }

  const threatModel = await getThreatModel(id)
  if (!threatModel) return Response.json({ error: 'Threat model not found' }, { status: 404 })

  if (rename.success) {
    const changed = await renameThreatModel(id, rename.data.systemName)
    if (!changed) return Response.json({ error: 'Threat model not found' }, { status: 404 })
    await logger.info('Analysis renamed', { analysisId: id, title: rename.data.systemName })
    return Response.json({ ok: true, id, systemName: rename.data.systemName })
  }

  if (!lifecycle.success) {
    return Response.json({ error: 'Request must include action or systemName' }, { status: 400 })
  }

  const action = lifecycle.data.action
  const changed = action === 'archive'
    ? await archiveThreatModel(id)
    : await restoreThreatModel(id)
  if (!changed) {
    return Response.json(
      { error: 'Only finished runs can be archived, and only archived runs can be restored.' },
      { status: 409 },
    )
  }

  const eventType = action === 'archive' ? 'analysis_archived' : 'analysis_restored'
  await logger.info(
    `Analysis ${action}d`,
    { analysisId: id, title: threatModel.title },
    { audit: { eventType, metadata: { analysisId: id, title: threatModel.title } } },
  )

  return Response.json({ ok: true, id, action })
})

export const DELETE = workspaceRoute(async (_req, { params }) => {
  const { id } = params as { id: string }
  const deleted = await permanentlyDeleteThreatModel(id)
  if (!deleted) {
    return Response.json(
      { error: 'Only finished runs can be permanently deleted.' },
      { status: 409 },
    )
  }

  let artifactsRemoved = true
  const workspace = activeWorkspaceOrNull()
  if (workspace) {
    try {
      await removeWorkspaceRunArtifacts(workspace, id)
    } catch (error) {
      artifactsRemoved = false
      await logger.warn('Analysis record deleted but local artifacts could not be removed', {
        analysisId: id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await logger.info(
    'Analysis permanently deleted',
    { analysisId: id, title: deleted.title, artifactsRemoved },
    { audit: { eventType: 'analysis_deleted', metadata: { analysisId: id, title: deleted.title, artifactsRemoved } } },
  )

  return Response.json({ ok: true, id, artifactsRemoved })
})
