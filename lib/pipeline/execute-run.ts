import { recoverBillingBlockedResult } from '@/lib/graph/billing-recovery'
import { isProviderBillingError } from '@/lib/llm/provider-errors'
import type { AnalysisMetadata } from '@/lib/db/schema'
import {
  completeThreatModelRun,
  failThreatModelRun,
  getThreatModel,
  markWebhookDelivered,
  saveTokenUsage,
} from '@/lib/storage/threat-models'
import {
  failRunArtifacts,
  finalizeRunArtifacts,
  initRunArtifacts,
  readPhaseCheckpoints,
  readRAGEvidenceCheckpoints,
  recordAttemptArtifact,
  recordRunProgress,
  recordRunResume,
  recordRunTelemetry,
  resumableCheckpointPhases,
  writeRunReportArtifact,
} from '@/lib/workspace/run-artifacts'
import { getConfig } from '@/lib/config'
import { buildThreatModelGraph, type PhaseOutput } from '@/lib/graph/builder'
import { RAGTraceCollector } from '@/lib/rag/trace'
import { probeRagHealth } from '@/lib/health/rag-status'
import { registerPipelineJob, abortPipelineJob } from '@/lib/pipeline-jobs'
import {
  assertOwnsPipelineLease,
  assertPipelineNotCancelled,
  getPipelineWorkerInstanceId,
  isPipelineCancellationRequested,
  isPipelineLeaseLost,
  syncPipelineCancellation,
  touchPipelineHeartbeat,
} from '@/lib/pipeline-cancellation'
import { persistPhaseOutput } from '@/lib/pipeline/persist-phase'
import { CheckpointWriteError } from '@/lib/pipeline/checkpoint-error'
import { PIPELINE_CANCEL_POLL_MS, PIPELINE_HEARTBEAT_MS } from '@/lib/pipeline/lease'
import { runWithAgentLogger } from '@/lib/agents/logger'
import { emptyUsage, estimateCost, runWithUsage, totalTokens } from '@/lib/llm/usage'
import { formatDebateRoundsMarkdown } from '@/lib/agents/debate-format'
import { logger } from '@/lib/logger'
import type { AnalysisConfig, ArchitectureData, DebateRound, ProgressEvent, RawThreat, UnifiedThreat } from '@/lib/models/types'
import { postSafeWebhook } from '@/lib/webhooks/client'
import { signWebhookBody } from '@/lib/webhooks/sign'
import { mapThreatsForWebhook } from '@/lib/webhooks/payload'
import { runWithEmbeddingDegradationHandler } from '@/lib/embeddings/client'
import { redactArchitectureSecrets, toPublicErrorMessage, isAbortLike } from '@/lib/utils/redact'
import { isMandatoryAnalystError, primaryPipelineError } from '@/lib/pipeline/mandatory-analyst'
import { runWithAttemptSink } from '@/lib/llm/attempt-diagnostics'
import { mapUnifiedThreatToRow } from '@/lib/db/helpers'
import type { RunManifestV2 } from '@/lib/runs/run-manifest'
import { resolvePipelineTimeouts } from '@/lib/pipeline-timeouts'
import { recordWorkerLiveness } from '@/lib/pipeline/worker-liveness'

const {
  pipelineTimeoutMs: PIPELINE_TIMEOUT_MS,
  phaseTimeoutMs: PIPELINE_PHASE_TIMEOUT_MS,
} = resolvePipelineTimeouts()

type PipelineResult = {
  architectureData?: unknown
  threatsFinal?: UnifiedThreat[]
  filteredCount?: number
  debateRounds?: DebateRound[]
  errors?: string[]
}

async function runPipeline(
  graph: Awaited<ReturnType<typeof buildThreatModelGraph>>,
  input: {
    systemName: string
    rawInput: string
    config: AnalysisConfig
    architectureData?: ArchitectureData
    strideThreats?: RawThreat[]
    pastaThreats?: RawThreat[]
    attackTreeThreats?: RawThreat[]
    resumedPhases?: string[]
    threatsKept?: RawThreat[]
    debateRounds?: DebateRound[]
    threatsPreDedup?: UnifiedThreat[]
    threatsFinal?: UnifiedThreat[]
    filteredCount?: number
  },
  assertNotCancelled: () => Promise<void>,
  signal?: AbortSignal,
): Promise<PipelineResult> {
  const graphStream = await graph.stream(input, {
    streamMode: 'values',
    ...(signal ? { signal } : {}),
  })
  let finalState: Record<string, unknown> = {}
  for await (const state of graphStream) {
    await assertNotCancelled()
    finalState = state as Record<string, unknown>
  }
  return finalState as PipelineResult
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  let timedOut = false
  const timeoutMessage = `Pipeline timed out after ${Math.round(ms / 1000)}s (${label})`
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      onTimeout?.()
      reject(new Error(timeoutMessage))
    }, ms)
  })
  const races: Promise<T | never>[] = [promise, timeout]
  if (signal) {
    const abortPromise = new Promise<never>((_, reject) => {
      const abort = () => {
        if (signal.reason instanceof Error) {
          reject(signal.reason)
          return
        }
        const err = new Error('Stopped by user')
        err.name = 'AbortError'
        reject(err)
      }
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
    })
    races.push(abortPromise)
  }
  return Promise.race(races)
    .catch((err: unknown) => {
      if (timedOut) throw new Error(timeoutMessage)
      throw err
    })
    .finally(() => clearTimeout(timer!))
}

function seedFromCheckpoints(
  reused: string[],
  checkpoints: NonNullable<Awaited<ReturnType<typeof readPhaseCheckpoints>>>,
) {
  const hasCheckpoint = (phase: string) => reused.includes(phase)
  return {
    resumedPhases: reused,
    ...(hasCheckpoint('architecture_parser') ? { architectureData: checkpoints.architecture! } : {}),
    ...(hasCheckpoint('stride_analyst') ? { strideThreats: checkpoints.strideThreats! } : {}),
    ...(hasCheckpoint('pasta_analyst') ? { pastaThreats: checkpoints.pastaThreats! } : {}),
    ...(hasCheckpoint('attack_tree_analyst') ? { attackTreeThreats: checkpoints.attackTreeThreats! } : {}),
    ...(hasCheckpoint('pre_dedup')
      ? { threatsKept: checkpoints.preDedup!.threatsKept, filteredCount: checkpoints.preDedup!.filteredCount }
      : {}),
    ...(hasCheckpoint('debate') ? { debateRounds: checkpoints.debateRounds! } : {}),
    ...(hasCheckpoint('threat_synthesizer') ? { threatsPreDedup: checkpoints.threatsPreDedup! } : {}),
    ...(hasCheckpoint('dread_validator')
      ? { threatsFinal: checkpoints.dread!.threatsFinal, filteredCount: checkpoints.dread!.filteredCount }
      : {}),
  }
}

/** Execute a run this worker already claimed. Next.js must not call this. */
export async function executePipelineRun(threatModelId: string): Promise<void> {
  const startTime = Date.now()
  const row = await getThreatModel(threatModelId)
  if (!row) {
    logger.error('Pipeline worker skipped missing analysis', { analysisId: threatModelId })
    return
  }
  const metadata = (row.metadata ?? {}) as AnalysisMetadata
  const config = metadata.analysis_config
  const runManifest = metadata.run_manifest as RunManifestV2 | undefined
  if (!config || !runManifest) {
    await persistFailedRun(threatModelId, 'Queued analysis is missing its execution contract.')
    return
  }
  const resumeFrom = metadata.resumeFrom
  const appConfig = getConfig()
  const usage = emptyUsage()
  const abortSignal = registerPipelineJob(threatModelId)
  await initRunArtifacts(threatModelId, row.title ?? 'Analysis', { analysisConfig: config, runManifest })

  let heartbeatInFlight = false
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return
    heartbeatInFlight = true
    void (async () => {
      try {
        const renewed = await touchPipelineHeartbeat(threatModelId)
        await recordWorkerLiveness(getPipelineWorkerInstanceId())
        if (renewed) await syncPipelineCancellation(threatModelId)
      } catch (err) {
        logger.warn('Failed to update pipeline heartbeat', {
          analysisId: threatModelId,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        heartbeatInFlight = false
      }
    })()
    void saveTokenUsage(threatModelId, totalTokens(usage)).catch(() => {})
  }, PIPELINE_HEARTBEAT_MS)
  const cancelPoll = setInterval(() => {
    void syncPipelineCancellation(threatModelId).catch(() => {})
  }, PIPELINE_CANCEL_POLL_MS)

  const webhookUrl = row.webhookUrl ?? undefined
  const webhookSecret = metadata.webhook_secret
  const externalId = row.externalId ?? undefined

  try {
    const ragTrace = new RAGTraceCollector()
    const completedOutputs: PhaseOutput[] = []
    async function onPhaseOutput(output: PhaseOutput): Promise<void> {
      completedOutputs.push(output)
      await assertOwnsPipelineLease(threatModelId, output.phase)
      await persistPhaseOutput(threatModelId, output, ragTrace)
      await assertOwnsPipelineLease(threatModelId, output.phase)
    }

    const selfCheckpoints = await readPhaseCheckpoints(threatModelId)
    const selfReused = resumableCheckpointPhases(selfCheckpoints)
    const other = !selfReused.length && resumeFrom && resumeFrom !== threatModelId
      ? await readPhaseCheckpoints(resumeFrom)
      : null
    const checkpointSource = selfReused.length ? threatModelId : resumeFrom
    const checkpoints = selfReused.length ? selfCheckpoints : other
    const reused = checkpoints ? resumableCheckpointPhases(checkpoints) : []
    const seed = checkpoints ? seedFromCheckpoints(reused, checkpoints) : {}

    const ragHealth = await probeRagHealth({
      ...appConfig.rag,
      ollamaBaseUrl: appConfig.llm.ollamaBaseUrl,
    })
    const ragRequested = config.useRag !== false
    const ragActive = ragRequested && ragHealth.usable
    const emitLog = async (message: string) => {
      await recordRunTelemetry(threatModelId, { message, at: Date.now() })
    }
    if (checkpointSource && reused.length) {
      logger.info('Resuming from checkpoints', {
        analysisId: threatModelId,
        resumeFrom: checkpointSource,
        reusedPhases: reused.join(', '),
      })
      await emitLog(`Resuming from ${checkpointSource}: reusing ${reused.length} phase(s)`)
      await recordRunResume(threatModelId, {
        from: checkpointSource,
        reusedPhases: reused.length,
        phaseNames: reused,
      })
    }
    if (!ragRequested) await emitLog('[pipeline] RAG disabled by operator — analysts will use architecture context only.')
    else if (!ragActive) await emitLog(`[pipeline] RAG skipped: ${ragHealth.reason}`)
    else await emitLog(`[pipeline] RAG enabled at ${ragHealth.endpoint}.`)

    if (ragActive && checkpointSource && reused.length) {
      for (const snapshot of await readRAGEvidenceCheckpoints(checkpointSource, reused)) ragTrace.restore(snapshot)
    }

    async function bgProgress(event: ProgressEvent): Promise<void> {
      await assertOwnsPipelineLease(threatModelId, event.status === 'start' ? event.phase : undefined)
      await recordRunProgress(threatModelId, event)
    }

    const graph = await buildThreatModelGraph(appConfig, config, (event) => bgProgress(event), {
      systemId: row.systemId,
      runId: threatModelId,
      checkCancelled: () => assertPipelineNotCancelled(threatModelId),
      signal: abortSignal,
      ragTrace,
      onPhaseOutput,
      ragActive,
      phaseTimeoutMs: PIPELINE_PHASE_TIMEOUT_MS,
      abortPipeline: (reason) => abortPipelineJob(threatModelId, reason),
    })

    const ragDegradationErrors: string[] = []
    const result = await runWithAttemptSink({
      runId: threatModelId,
      record: (diagnostic, rejected) => recordAttemptArtifact(threatModelId, diagnostic, rejected),
    }, () => runWithUsage(usage, () => runWithEmbeddingDegradationHandler((message) => {
      if (!ragDegradationErrors.includes(message)) ragDegradationErrors.push(message)
      void emitLog(`[pipeline] ${message}`)
    }, () => runWithAgentLogger((message) => { void emitLog(message) }, () => withTimeout(
      runPipeline(
        graph,
        { systemName: row.title ?? 'Analysis', rawInput: row.input, config, ...seed },
        () => assertPipelineNotCancelled(threatModelId),
        abortSignal,
      ),
      PIPELINE_TIMEOUT_MS,
      row.title ?? 'Analysis',
      abortSignal,
      () => { abortPipelineJob(threatModelId) },
    ))))).catch(async (error) => {
      if (!isProviderBillingError(error)) throw error
      await assertPipelineNotCancelled(threatModelId)
      await emitLog('[pipeline] Provider billing exhausted; stopping remaining model stages and preserving completed outputs.')
      return recoverBillingBlockedResult(seed, completedOutputs, error)
    })

    const durationMs = Date.now() - startTime
    const threatsList = (result.threatsFinal ?? []) as UnifiedThreat[]
    const threatsToInsert = threatsList.map((t) => mapUnifiedThreatToRow(t as never, threatModelId))
    const archData = redactArchitectureSecrets(
      result.architectureData as { systemDescription?: string } | undefined,
    )
    const debateSummary = result.debateRounds?.length
      ? formatDebateRoundsMarkdown(result.debateRounds, result.threatsFinal ?? [])
      : null
    const methodologyMap: Record<string, string> = {
      stride: 'STRIDE', pasta: 'PASTA', attack_tree: 'ATTACK_TREE',
    }
    const methodologiesUsed = config.enabledAnalysts.map((a) => methodologyMap[a] ?? a.toUpperCase())
    const pipelineErrors = [...new Set([...(result.errors ?? []), ...ragDegradationErrors])]
    const status = pipelineErrors.length ? 'partial' as const : 'completed' as const

    await assertOwnsPipelineLease(threatModelId, 'pipeline_complete')
    await recordRunProgress(threatModelId, {
      phase: 'pipeline_complete',
      status: 'done',
      timestamp: Date.now(),
    })
    await finalizeRunArtifacts(
      threatModelId,
      archData ?? result.architectureData ?? null,
      result.threatsFinal ?? [],
      {
        totalThreats: threatsList.length,
        filteredThreats: result.filteredCount ?? 0,
        durationMs,
        methodologiesUsed,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          calls: usage.calls,
          byModel: usage.byModel,
          byProviderModelAgent: usage.byProviderModelAgent,
          estimatedCostUsd: estimateCost(usage).totalUsd,
          unpricedModels: estimateCost(usage).unpricedModels,
        },
      },
      ragTrace.snapshot(),
      status,
      debateSummary ?? '',
    )
    await completeThreatModelRun(
      threatModelId,
      {
        systemDescription: archData?.systemDescription ?? null,
        debateSummary,
        methodologiesUsed,
        architectureJson: archData ?? result.architectureData,
        totalThreats: threatsList.length,
        filteredThreats: result.filteredCount ?? 0,
        executionTimeSeconds: Math.round(durationMs / 1000),
        llmTokensUsed: totalTokens(usage),
        pipelineErrors: pipelineErrors.length ? pipelineErrors : null,
        currentPhase: 'pipeline_complete',
        ragTrace: ragTrace.snapshot(),
        status,
        workerInstanceId: getPipelineWorkerInstanceId(),
      },
      threatsToInsert,
    )
    await writeRunReportArtifact(threatModelId).catch((err) => {
      logger.warn('Failed to generate markdown report artifact', {
        analysisId: threatModelId,
        error: err instanceof Error ? err.message : String(err),
      })
    })

    logger.info('Analysis completed', {
      analysisId: threatModelId,
      totalThreats: threatsList.length,
      durationMs,
    }, { audit: { eventType: 'analysis_completed' } })

    if (webhookUrl) {
      const delivered = await deliverWebhook(webhookUrl, webhookSecret, {
        analysisId: threatModelId,
        externalId,
        status,
        completedAt: new Date().toISOString(),
        summary: {
          totalThreats: threatsList.length,
          criticalCount: threatsList.filter((t) => t.scoringStatus !== 'unscored' && t.priority === 'critical').length,
          highCount: threatsList.filter((t) => t.scoringStatus !== 'unscored' && t.priority === 'high').length,
          mediumCount: threatsList.filter((t) => t.scoringStatus !== 'unscored' && t.priority === 'medium').length,
          lowCount: threatsList.filter((t) => t.scoringStatus !== 'unscored' && t.priority === 'low').length,
          durationMs,
        },
        threats: mapThreatsForWebhook(threatsList),
      })
      if (delivered) await markWebhookDelivered(threatModelId)
    }
  } catch (err) {
    if (isPipelineLeaseLost(err) || isPipelineLeaseLost(abortSignal.reason)) {
      logger.warn('Released pipeline after losing the lease', {
        analysisId: threatModelId,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    let cancellationRequested = false
    if (!isAbortLike(err)) {
      try {
        cancellationRequested = await isPipelineCancellationRequested(threatModelId)
      } catch (checkErr) {
        logger.warn('Failed to check cancellation status while handling pipeline error', {
          analysisId: threatModelId,
          error: checkErr instanceof Error ? checkErr.message : String(checkErr),
        })
      }
    }
    const primary = primaryPipelineError(err, abortSignal)
    const stopped = (isAbortLike(primary) && !isMandatoryAnalystError(primary)) || cancellationRequested
    const rawMsg = primary instanceof Error ? primary.message : String(primary)
    const msg = primary instanceof CheckpointWriteError
      ? rawMsg
      : stopped ? 'Stopped by user' : toPublicErrorMessage(primary, 'Analysis failed')
    logger.error('Analysis failed', {
      analysisId: threatModelId,
      error: rawMsg,
      publicError: msg,
      stopped,
    }, { audit: { eventType: 'analysis_failed' } })
    await recordRunTelemetry(threatModelId, { message: `[pipeline] ${msg}`, at: Date.now() }).catch(() => {})
    await saveTokenUsage(threatModelId, totalTokens(usage)).catch(() => {})
    await persistFailedRun(threatModelId, msg, Date.now() - startTime)
    if (webhookUrl) {
      await deliverWebhook(webhookUrl, webhookSecret, {
        analysisId: threatModelId,
        externalId,
        status: 'failed',
        error: msg,
      })
    }
  } finally {
    clearInterval(heartbeat)
    clearInterval(cancelPoll)
    abortPipelineJob(threatModelId)
  }
}

async function persistFailedRun(threatModelId: string, message: string, durationMs?: number): Promise<void> {
  const workerInstanceId = getPipelineWorkerInstanceId()
  const owned = await failThreatModelRun(threatModelId, message, workerInstanceId, durationMs)
  if (!owned) {
    const row = await getThreatModel(threatModelId)
    const stillAssigned = row?.workerInstanceId === workerInstanceId
    const cancelledByOperator = Boolean(row?.cancelRequestedAt)
    if (!stillAssigned || !cancelledByOperator) {
      logger.warn('Skipped failing a run this worker no longer owns', { analysisId: threatModelId })
      return
    }
  }
  try {
    await failRunArtifacts(threatModelId, message)
  } catch (err) {
    const writeMessage = err instanceof Error ? err.message : String(err)
    logger.warn('Failed to record run failure artifact after fencing the row', {
      analysisId: threatModelId,
      error: writeMessage,
    })
  }
}

const WEBHOOK_TIMEOUT_MS = 15_000
const WEBHOOK_MAX_RETRIES = 3

async function deliverWebhook(
  url: string,
  secret: string | undefined,
  payload: object,
): Promise<boolean> {
  const body = JSON.stringify(payload)
  const requestHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    requestHeaders['Authorization'] = `Bearer ${secret}`
    requestHeaders['X-AgenticTM-Timestamp'] = timestamp
    requestHeaders['X-AgenticTM-Signature'] = signWebhookBody(body, secret, timestamp)
  }
  let hostname = 'unknown'
  try {
    hostname = new URL(url).hostname
  } catch {
    // assertSafeWebhookUrl will reject
  }
  for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
    const result = await postSafeWebhook(url, requestHeaders, body, WEBHOOK_TIMEOUT_MS)
    if (!result.ok && result.hostname === 'unknown') {
      logger.warn('Webhook URL failed SSRF check', { hostname, attempt, error: result.error })
      return false
    }
    if (result.ok) {
      logger.info('Webhook delivered', { hostname: result.hostname, attempt, status: result.status })
      return true
    }
    logger.warn('Webhook delivery failed', {
      hostname: result.hostname ?? hostname,
      attempt,
      status: result.status,
      error: result.error,
    })
  }
  return false
}
