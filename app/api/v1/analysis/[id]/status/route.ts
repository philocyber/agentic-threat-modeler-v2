import { workspaceRoute } from '@/lib/local-route'
import { analysisDeliveredResults } from '@/lib/models/analysis-status'
import type { AnalysisStatusResponse } from '@/lib/models/types'
import { parseProgressEvents } from '@/lib/runs/progress-events'
import { listCompletedPhases, readRunArtifactTextLenient } from '@/lib/storage/artifacts'
import { getThreatModel } from '@/lib/storage/threat-models'

export const GET = workspaceRoute(async (_req, { params }) => {
  if (!params?.id) {
    return Response.json({ error: 'Missing analysis ID' }, { status: 400 })
  }
  const analysisId = params.id

  const threatModel = await getThreatModel(analysisId)
  if (!threatModel) {
    return Response.json({ error: 'Analysis not found' }, { status: 404 })
  }

  const persistedEvents = parseProgressEvents(await readRunArtifactTextLenient(analysisId, 'progress.jsonl'))
  const progressEvents = persistedEvents
  const allPhases = [
    'architecture_parser',
    'stride_analyst',
    'pasta_analyst',
    'attack_tree_analyst',
    'pre_dedup',
    'debate',
    'threat_synthesizer',
    'dread_validator',
  ]
  // The event buffer only holds what this server process has seen. Phases whose
  // output already reached disk are authoritative, so a restart or a recompile
  // no longer resets a live run back to zero completed phases.
  const persistedPhases = await listCompletedPhases(analysisId)
  const failedPhases = [
    ...persistedPhases
      .filter((phase) => phase.endsWith('.degraded'))
      .map((phase) => phase.slice(0, -'.degraded'.length)),
    ...progressEvents.filter((event) => event.status === 'error').map((event) => event.phase),
  ].filter((phase, index, phases) => phases.indexOf(phase) === index)
  const completedPhases = [
    ...persistedPhases.filter((phase) => allPhases.includes(phase)),
    ...progressEvents.filter((event) => event.status === 'done').map((event) => event.phase),
  ].filter((phase, index, phases) => phases.indexOf(phase) === index && !failedPhases.includes(phase))
  const terminalPhases = new Set([...completedPhases, ...failedPhases])
  const startEvents = progressEvents.filter((event) => event.status === 'start')
  const lastStartEvent = startEvents.findLast((event) => !terminalPhases.has(event.phase))
  const persistedCurrentPhase = threatModel.currentPhase && !terminalPhases.has(threatModel.currentPhase)
    ? threatModel.currentPhase
    : undefined
  const currentPhase = lastStartEvent?.phase ?? persistedCurrentPhase
  const remainingPhases = allPhases.filter(
    (phase) => !terminalPhases.has(phase) && phase !== currentPhase,
  )
  const percentage = analysisDeliveredResults(threatModel.status)
    ? 100
    : Math.round((terminalPhases.size / allPhases.length) * 100)

  const body: AnalysisStatusResponse = {
    analysis_id: threatModel.id,
    status: threatModel.status,
    progress: {
      events: progressEvents,
      current_phase: currentPhase,
      phases_completed: completedPhases,
      phases_failed: failedPhases,
      phases_remaining: remainingPhases,
      percentage,
    },
    started_at: threatModel.createdAt.toISOString(),
    completed_at: threatModel.completedAt?.toISOString(),
    metadata: threatModel.metadata,
    ...(threatModel.status === 'failed' && {
      error_message: threatModel.errorMessage,
      stop_reason: threatModel.cancelRequestedAt ? ('user_cancelled' as const) : undefined,
    }),
  }

  return Response.json(body)
})
