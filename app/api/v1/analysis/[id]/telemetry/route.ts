import { workspaceRoute } from '@/lib/local-route'
import { isTerminalAnalysisStatus } from '@/lib/models/analysis-status'
import {
  buildTelemetrySnapshot,
  classifyTelemetryMessage,
  type TelemetryLine,
} from '@/lib/runs/telemetry'
import { getThreatModel } from '@/lib/storage/threat-models'
import { readRunArtifactTextLenient } from '@/lib/storage/artifacts'
import type { AnalysisConfig, AnalysisMetadata } from '@/lib/db/schema'
import type { ProgressEvent } from '@/lib/models/types'

type TelemetryRunManifest = {
  resume?: { from?: unknown; reusedPhases?: unknown; phaseNames?: unknown }
}

function parseJsonl(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line)
        return value && typeof value === 'object' && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : []
      } catch {
        return []
      }
    })
}

function lineFromRecord(record: Record<string, unknown>): TelemetryLine | null {
  if (typeof record.message !== 'string') return null
  const at =
    typeof record.at === 'number'
      ? record.at
      : typeof record.at === 'string'
        ? Date.parse(record.at) || Date.now()
        : Date.now()
  const classified = classifyTelemetryMessage(record.message, at)
  return {
    ...classified,
    ...(typeof record.kind === 'string' ? { kind: classified.kind } : {}),
  }
}

function progressFromRecord(record: Record<string, unknown>): ProgressEvent | null {
  if (typeof record.phase !== 'string') return null
  if (record.status !== 'start' && record.status !== 'done' && record.status !== 'error') return null
  const timestamp =
    typeof record.timestamp === 'number'
      ? record.timestamp
      : typeof record.at === 'string'
        ? Date.parse(record.at) || Date.now()
        : Date.now()
  return {
    phase: record.phase,
    status: record.status,
    timestamp,
    ...(typeof record.count === 'number' ? { count: record.count } : {}),
  }
}

export const GET = workspaceRoute(async (req, { params }) => {
  if (!params?.id) {
    return Response.json({ error: 'Missing analysis ID' }, { status: 400 })
  }
  const analysisId = params.id
  const threatModel = await getThreatModel(analysisId)
  if (!threatModel) {
    return Response.json({ error: 'Analysis not found' }, { status: 404 })
  }

  const live = !isTerminalAnalysisStatus(threatModel.status)
  let diskProgress: ProgressEvent[] = []
  let diskLogs: TelemetryLine[] = []
  let runManifest: TelemetryRunManifest | null = null
  const [progressText, telemetryText, manifestText] = await Promise.all([
    readRunArtifactTextLenient(analysisId, 'progress.jsonl'),
    readRunArtifactTextLenient(analysisId, 'telemetry.jsonl'),
    readRunArtifactTextLenient(analysisId, 'run.json'),
  ])
  if (new URL(req.url).searchParams.get('format') === 'jsonl') {
    return new Response(telemetryText ?? '', {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${analysisId.replace(/[^a-zA-Z0-9_-]/g, '')}-telemetry.jsonl"`,
        'Cache-Control': 'no-store',
      },
    })
  }
  diskProgress = parseJsonl(progressText ?? '').flatMap((record) => {
    const event = progressFromRecord(record)
    return event ? [event] : []
  })
  diskLogs = parseJsonl(telemetryText ?? '').flatMap((record) => {
    const line = lineFromRecord(record)
    return line ? [line] : []
  })
  try {
    runManifest = manifestText ? JSON.parse(manifestText) as TelemetryRunManifest : null
  } catch {
    runManifest = null
  }

  const progressByKey = new Map<string, ProgressEvent>()
  for (const event of diskProgress) {
    progressByKey.set(`${event.phase}:${event.status}:${event.timestamp}`, event)
  }

  const metadata = threatModel.metadata as AnalysisMetadata | null
  const config = metadata?.analysis_config as AnalysisConfig | undefined
  const requested = config?.useRag !== false
  const lines = diskLogs
  const pipelineSkip = lines.find((line) =>
    /\[pipeline\].*(RAG skipped|RAG disabled by operator)/i.test(line.message),
  )
  const prefetchFail = lines.find((line) => /RAG prefetch unavailable/i.test(line.message))
  const rag = {
    requested,
    active: requested && !pipelineSkip,
    ...(!requested
      ? { reason: 'Operator turned off knowledge retrieval for this run.' }
      : pipelineSkip
        ? { reason: pipelineSkip.message }
        : prefetchFail
          ? { reason: `Prefetch failed; evidence continued without a ReAct tool loop. ${prefetchFail.message}` }
          : {}),
  }

  const resumeData = runManifest?.resume
  const resumeFrom = typeof resumeData?.from === 'string'
    ? resumeData.from
    : metadata?.resumeFrom
  const reusedPhases = typeof resumeData?.reusedPhases === 'number' ? resumeData.reusedPhases : 0
  const explicitPhaseNames = Array.isArray(resumeData?.phaseNames)
    ? resumeData.phaseNames.filter((phase: unknown): phase is string => typeof phase === 'string')
    : []
  const progress = [...progressByKey.values()].sort((a, b) => a.timestamp - b.timestamp)
  const completedNames = [...new Set(progress.filter((event) => event.status === 'done').map((event) => event.phase))]
  // Older manifests only recorded the number. Eight reused phases means the
  // whole core pipeline was restored, so it is still safe to label all rows.
  const inferredPhaseNames = explicitPhaseNames.length > 0
    ? explicitPhaseNames
    : reusedPhases === completedNames.length
      ? completedNames
      : []

  return Response.json(
    buildTelemetrySnapshot({
      live,
      progress,
      events: diskLogs.sort((a, b) => a.at - b.at),
      rag,
      ...(resumeFrom ? { resume: { from: resumeFrom, reusedPhases, phaseNames: inferredPhaseNames } } : {}),
    }),
  )
})
