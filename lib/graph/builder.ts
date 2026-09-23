import { recordProviderFailure } from '@/lib/llm/usage'
import { planSourceAnalysis } from '@/lib/agents/source-analysis'
import { agentLog } from '@/lib/agents/logger'
import { batchedPhaseTimeoutMs, resolvePipelineTimeouts, sourcePhaseTimeoutMs } from '@/lib/pipeline-timeouts'
import { assertExtractionCoverage, assertAnalystCoverage, hasAnalystDelivery } from '@/lib/architecture/source-evidence'
import { StateGraph, Annotation, END, START } from '@langchain/langgraph'
import { getLLM } from '@/lib/llm/factory'
import { canRouteToProvider, providerBatchConcurrency } from '@/lib/llm/execution-profiles'
import { prepareLocalTokenCounters } from '@/lib/llm/local-token-counter'
import { getRAGStore } from '@/lib/rag/store'
import { createIdleRAGTools, createRAGTools } from '@/lib/rag/tools'
import { getCorporateRAGStore } from '@/lib/rag/corporate-store'
import { runArchitectureParser } from '@/lib/agents/architecture-parser'
import { runStrideAnalyst } from '@/lib/agents/stride-analyst'
import { runPastaAnalyst } from '@/lib/agents/pasta-analyst'
import { runAttackTreeAnalyst } from '@/lib/agents/attack-tree-analyst'
import { runDebateRound } from '@/lib/agents/debate'
import { chunkDebateBatches, candidatesNeedingReplay, mergeReplayedDebateRound } from '@/lib/agents/debate-batches'
import { debateProfileFor } from '@/lib/agents/debate-profile'
import { runDebateSession } from '@/lib/agents/debate-session'
import { latestDebateAssessments } from '@/lib/agents/debate-quality'
import { runThreatSynthesizer } from '@/lib/agents/threat-synthesizer'
import { runDreadValidator, validatorConcurrency, VALIDATOR_BATCH_SIZE } from '@/lib/agents/dread-validator'
import { buildValidatorContext } from '@/lib/agents/dread-context'
import { filterByEvidencePolicy } from '@/lib/agents/base'
import { rawToUnified } from '@/lib/agents/reconcile'
import { inScopeCandidates } from '@/lib/agents/candidate-quality'
import { deduplicateRawThreats } from '@/lib/agents/dedup'
import { createOllamaBatchEmbedFn } from '@/lib/embeddings/client'
import type { AppConfig } from '@/lib/config'
import type { AnalysisConfig } from '@/lib/db/schema'
import type {
  ArchitectureData,
  ThreatModelState,
  RawThreat,
  UnifiedThreat,
  DebateCandidate,
  DebateRound,
  DegradedAgentInfo,
  ProgressEvent,
} from '@/lib/models/types'
import { MandatoryAnalystError, isMandatoryAnalystError, primaryPipelineError } from '@/lib/pipeline/mandatory-analyst'
import { withTelemetrySpan } from '@/lib/observability/telemetry'
import { buildReviewerLearningSection } from '@/lib/agents/learning-context'
import { countReviewExamplesUsed } from '@/lib/storage/review-learning'
import { logger } from '@/lib/logger'
import { toPublicErrorMessage } from '@/lib/utils/redact'
import { wireAnalystEdges } from '@/lib/graph/execution-mode'
import { attachArchitectureFactLedger } from '@/lib/architecture/fact-ledger'
import { applyControlAwareValidation } from '@/lib/agents/control-awareness'
import { buildRAGRetrievalPlan, type RAGTraceCollector } from '@/lib/rag/trace'
import { CheckpointWriteError } from '@/lib/pipeline/checkpoint-error'
import { isPipelineLeaseLost, leaseLostError } from '@/lib/pipeline/lease-error'

// ─── State annotation ─────────────────────────────────────────────────────────

const ThreatModelAnnotation = Annotation.Root({
  systemName: Annotation<string>(),
  rawInput: Annotation<string>(),
  config: Annotation<ThreatModelState['config']>(),

  architectureData: Annotation<ThreatModelState['architectureData']>(),
  sourceDelivery: Annotation<Record<string, string[]>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),

  strideThreats: Annotation<RawThreat[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  pastaThreats: Annotation<RawThreat[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  attackTreeThreats: Annotation<RawThreat[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),

  // Names of phases inherited by a resumed run. This marker distinguishes a
  // valid empty checkpoint from the annotation's empty-array default.
  resumedPhases: Annotation<string[]>({
    reducer: (_a, b) => b ?? [],
    default: () => [],
  }),

  debateRounds: Annotation<DebateRound[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),

  // Confidence-filtered raw threats flowing into debate + synthesis
  threatsKept: Annotation<RawThreat[]>({
    reducer: (_a, b) => b ?? [],
    default: () => [],
  }),

  threatsPreDedup: Annotation<UnifiedThreat[]>(),
  threatsFinal: Annotation<UnifiedThreat[]>(),
  filteredCount: Annotation<number>(),
  errors: Annotation<string[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  // Analysts that exhausted retries and continued degraded (empty output).
  // The pipeline never degrades silently; the UI renders this as a banner.
  degradedAgents: Annotation<DegradedAgentInfo[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  progressEvents: Annotation<ProgressEvent[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
})

type GraphState = typeof ThreatModelAnnotation.State
/**
 * Emitted as soon as a phase produces output, so a run that later times out or
 * is stopped keeps the work already paid for instead of discarding the whole
 * in-memory state.
 */
export type PhaseOutput =
  | { phase: 'architecture_parser'; architecture: ArchitectureData }
  | { phase: 'stride_analyst' | 'pasta_analyst' | 'attack_tree_analyst'; threats: RawThreat[]; sourceDelivery?: string[] | undefined }
  | { phase: 'pre_dedup'; threatsKept: RawThreat[]; filteredCount: number }
  | { phase: 'debate'; debateRounds: DebateRound[]; complete?: boolean }
  | { phase: 'threat_synthesizer'; threatsPreDedup: UnifiedThreat[] }
  | { phase: 'dread_validator'; threatsFinal: UnifiedThreat[]; filteredCount: number }
  | { phase: string; degraded: true; error: string }

type GraphOptions = {
  systemId?: string | null
  runId?: string
  checkCancelled?: () => Promise<void>
  signal?: AbortSignal | undefined
  ragTrace?: RAGTraceCollector
  onPhaseOutput?: (output: PhaseOutput) => void | Promise<void>
  /** When false, analysts run without Chroma tools or prefetch. */
  ragActive?: boolean
  phaseTimeoutMs?: number | undefined
  abortPipeline?: ((reason?: unknown) => void) | undefined
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkEvent(phase: string, status: 'start' | 'done' | 'error', count?: number): ProgressEvent {
  return { phase, status, timestamp: Date.now(), count }
}

function log(phase: string, status: 'start' | 'done', extra?: string) {
  const icon = status === 'start' ? '▶' : '✓'
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[pipeline ${ts}] ${icon} ${phase}${extra ? `: ${extra}` : ''}`)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function cancellationError(): Error {
  const error = new Error('Stopped by user')
  error.name = 'AbortError'
  return error
}

/**
 * The debate keys everything by `DRAFT-n`, assigned by confidence order over the
 * kept candidates. Synthesized threats carry `candidateId`s instead, so the two
 * are joined here with the same ordering the debate node used, or the ruling
 * would land on the wrong threat.
 */
function candidateIdsByDraft(
  state: { threatsKept?: RawThreat[] | undefined },
  debateCandidateCap: number,
): Map<string, string> {
  const kept = state.threatsKept ?? []
  const ordered = kept
    .slice()
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, Math.min(kept.length, debateCandidateCap))
  const map = new Map<string, string>()
  ordered.forEach((threat, index) => {
    if (threat.candidateId) map.set(`DRAFT-${index + 1}`, threat.candidateId)
  })
  return map
}

// ─── Graph builder ────────────────────────────────────────────────────────────

export async function buildThreatModelGraph(
  config: AppConfig,
  requestConfig?: AnalysisConfig,
  onProgress?: (event: ProgressEvent) => void | Promise<void>,
  options?: GraphOptions
) {
  const checkCancelled = options?.checkCancelled ?? (async () => {})
  const signal = options?.signal
  const emitPhaseOutput = async (output: PhaseOutput) => {
    await options?.onPhaseOutput?.(output)
  }
  const ragActive = options?.ragActive !== false
  const ragTools = ragActive
    ? createRAGTools(
      await getRAGStore(config),
      await getCorporateRAGStore(config),
      options?.ragTrace,
      config.rag.knowledgeBasePath,
      options?.systemId,
      options?.runId,
    )
    : createIdleRAGTools()

  const requestedProvider = requestConfig?.provider ?? config.llm.provider
  const allowedProviders = requestConfig?.allowedProviders ?? [requestedProvider]
  if (!canRouteToProvider(allowedProviders, requestedProvider)) {
    throw new Error(`Provider "${requestedProvider}" is outside the authorized routing boundary`)
  }

  const quickOverride = requestConfig?.quickModel
  const deepOverride = requestConfig?.deepModel

  // Temporarily bind provider from request config for this graph build
  const effectiveConfig =
    requestConfig?.provider && requestConfig.provider !== config.llm.provider
      ? {
          ...config,
          llm: { ...config.llm, provider: requestConfig.provider },
        }
      : config
  // Resolve the provider's complete debate plan once. The same candidate cap
  // and batch geometry must govern debate, synthesis joins and telemetry.
  const debateProfile = debateProfileFor(effectiveConfig.llm.provider)

  // Shared models write prose evidence as well as structured results.
  // invokeStructured applies each result schema at call time; forcing JSON on
  // the shared client conflicts with the evidence phase's prose instructions.
  const quickLLM = getLLM(effectiveConfig, 'quick', false, quickOverride)
  const deepLLM = getLLM(effectiveConfig, 'deep', false, deepOverride)
  const kimiFullPower =
    effectiveConfig.llm.provider === 'kimi'
    && requestConfig?.executionProfile === 'provider_full_power'
  // Architecture extraction is a bounded, schema-constrained inventory task.
  // Full Power still selects the provider's deep model, but runs it with the
  // quick role so Kimi K3 uses low reasoning effort and the smaller output cap.
  // High reasoning on every 14 KB section left individual requests generating
  // for 15 minutes even after the other sections had completed.
  const parserOverride =
    requestConfig?.executionProfile === 'provider_full_power' ? deepOverride : quickOverride
  const parserLLM = getLLM(effectiveConfig, 'quick', true, parserOverride, 0.1)
  // On local hardware the deep model cannot reliably emit a full analyst list
  // inside the per-call timeout. Use the quick model for enumeration and the
  // blue-team pass, while retaining the deep model for synthesis and red-team
  // adjudication where its additional reasoning has the highest value.
  const analystOverride = effectiveConfig.llm.provider === 'ollama' ? quickOverride : deepOverride
  // Kimi K3 high reasoning has repeatedly held structured requests open for
  // 15-18 minutes after the client-side 300s abort. Keep the Full Power K3
  // model selection, context and schema, but use its low reasoning contract so
  // provider stalls cannot erase an otherwise complete analyst result.
  const analystRole = kimiFullPower ? 'quick' : 'stride'
  const strideLLM = getLLM(effectiveConfig, analystRole, false, analystOverride, 0.65)
  // Every analyst runs on the same tier. Splitting them (STRIDE on the strong
  // tier, PASTA and attack-tree on the quick one) made the quick-tier analysts
  // fail on every run against a provider whose quick model truncates long
  // structured answers, while STRIDE completed. `analystOverride` still keeps
  // Ollama on its quick model, where the deep one cannot finish in time.
  const analystLLM = strideLLM
  const blueLLM = getLLM(effectiveConfig, analystRole, false, analystOverride, 0.15)
  const synthesisEmissionLLM = kimiFullPower
    ? getLLM(effectiveConfig, 'quick', false, deepOverride, 0.2)
    : deepLLM
  await prepareLocalTokenCounters([quickLLM, deepLLM, parserLLM, analystLLM, blueLLM, synthesisEmissionLLM], effectiveConfig.llm.ollamaBaseUrl)
  const telemetryAttributes = {
    provider: effectiveConfig.llm.provider,
  }

  const reviewerLearning = await buildReviewerLearningSection(options?.systemId, options?.runId)
  if (reviewerLearning && options?.systemId) {
    const counts = await countReviewExamplesUsed(options.systemId, options.runId)
    logger.info('Reviewer learning examples loaded for pipeline', counts, {
      audit: { eventType: 'reviewer_learning_applied', metadata: counts },
    })
  }

  const executionMode: AnalysisConfig['executionMode'] =
    requestConfig?.executionMode ?? config.pipeline.executionMode

  async function runPhase<T>(phase: string, operation: () => Promise<T>, sourceArchitecture?: ArchitectureData, batchWork?: { count: number; concurrency: number }): Promise<T> {
    let timeoutMs = options?.phaseTimeoutMs
    if (timeoutMs && timeoutMs > 0 && batchWork) {
      timeoutMs = batchedPhaseTimeoutMs(timeoutMs, batchWork.count, batchWork.concurrency, resolvePipelineTimeouts().pipelineTimeoutMs)
      agentLog(`[${phase}] Batch plan: ${batchWork.count} batches, concurrency ${batchWork.concurrency}, phase ceiling ${Math.round(timeoutMs / 60000)} minutes; global run deadline still applies`)
    }
    if (timeoutMs && timeoutMs > 0 && sourceArchitecture?.sourceEvidence) {
      const plan = planSourceAnalysis(sourceArchitecture, [analystLLM, quickLLM])
      const passes = plan.packets.length + plan.reconciliation.length
      timeoutMs = sourcePhaseTimeoutMs(timeoutMs, passes, resolvePipelineTimeouts().pipelineTimeoutMs)
      agentLog(`[${phase}] Source plan: ${passes} passes, phase ceiling ${Math.round(timeoutMs / 60000)} minutes; global run deadline still applies`)
    }
    const execution = withTelemetrySpan(`pipeline.${phase}`, { phase, ...telemetryAttributes }, operation)
    if (!timeoutMs || timeoutMs <= 0) return execution
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Phase ${phase} timed out after ${Math.round(timeoutMs / 1000)}s`)
        error.name = 'PhaseTimeoutError'
        options?.abortPipeline?.(error)
        reject(error)
      }, timeoutMs)
    })
    return Promise.race([execution, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  async function rethrowIfCancelled(error: unknown): Promise<void> {
    const primary = primaryPipelineError(error, signal)
    if (isMandatoryAnalystError(primary)) throw primary
    const billingFailure = recordProviderFailure(error)
    if (billingFailure) throw billingFailure
    // Provider SDKs do not consistently preserve AbortError when an in-flight
    // request is cancelled; some surface TypeError/fetch errors instead. The
    // signal and durable DB flag are authoritative, so cancellation must never
    // be downgraded into a partial analyst failure.
    if (error instanceof Error && error.name === 'PhaseTimeoutError') throw error
    if (error instanceof CheckpointWriteError) throw error
    if (signal?.aborted && isPipelineLeaseLost(signal.reason)) throw leaseLostError()
    if (isPipelineLeaseLost(error)) throw error
    if (signal?.aborted || isAbortError(error)) throw cancellationError()
    await checkCancelled()
  }

  async function emitProgress(event: ProgressEvent): Promise<void> {
    await onProgress?.(event)
  }

  async function start(phase: string): Promise<ProgressEvent> {
    const e = mkEvent(phase, 'start')
    log(phase, 'start')
    await emitProgress(e)
    return e
  }

  async function done(phase: string, count?: number): Promise<ProgressEvent> {
    const e = mkEvent(phase, 'done', count)
    log(phase, 'done', count != null ? `${count} items` : undefined)
    await emitProgress(e)
    return e
  }

  const graph = new StateGraph(ThreatModelAnnotation)

  // ── Phase I: Architecture parsing ─────────────────────────────────────────
  graph.addNode('architecture_parser', async (state: GraphState) => {
    await checkCancelled()
    // Seeded by a resumed run: the previous attempt already paid for this phase.
    if (state.resumedPhases.includes('architecture_parser') && state.architectureData) {
      assertExtractionCoverage(state.architectureData)
      log('architecture_parser', 'done', 'reused from checkpoint')
      ragTools.router.setPlan({ ...buildRAGRetrievalPlan(state.architectureData), system: state.systemName })
      // Re-bank the inherited phase: without this the resumed run owns no
      // checkpoints of its own and cannot itself be resumed.
      await emitPhaseOutput({ phase: 'architecture_parser', architecture: state.architectureData })
      return { progressEvents: [await start('architecture_parser'), await done('architecture_parser')] }
    }
    const eStart = await start('architecture_parser')
    try {
      const parsedArchitecture = await runPhase('architecture_parser', () =>
        runArchitectureParser(parserLLM, state.rawInput, signal)
      )
      const architectureData = attachArchitectureFactLedger(state.rawInput, parsedArchitecture)
      await emitPhaseOutput({ phase: 'architecture_parser', architecture: architectureData })
      assertExtractionCoverage(architectureData)
      if (requestConfig?.enabledAnalysts?.length !== 0) {
        const plan = planSourceAnalysis(architectureData, [analystLLM, quickLLM])
        log('architecture_parser', 'done', `Source plan: ${architectureData.sourceEvidence?.sections.length ?? 0} sections, ${plan.packets.length} analyst groups, ${plan.reconciliation.length} reconciliation groups, ${plan.budget} source characters per group`)
      }
      ragTools.router.setPlan({ ...buildRAGRetrievalPlan(architectureData), system: state.systemName })
      await checkCancelled()
      return {
        architectureData,
        progressEvents: [eStart, await done('architecture_parser')],
      }
    } catch (err) {
      await rethrowIfCancelled(err)
      if (err instanceof Error && err.name === 'SourceCoverageError') throw err
      throw new Error(`ArchitectureParser failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // ── Phase II: Analyst fan-out ──────────────────────────────────────────────
  graph.addNode('stride_analyst', async (state: GraphState) => {
    await checkCancelled()
    // Seeded by a resumed run: reuse instead of paying for this analyst again.
    if (state.resumedPhases.includes('stride_analyst') && hasAnalystDelivery(state.architectureData, 'stride')) {
      log('stride_analyst', 'done', `reused ${state.strideThreats.length} threats from checkpoint`)
      await emitPhaseOutput({ phase: 'stride_analyst', threats: state.strideThreats, sourceDelivery: state.architectureData?.sourceEvidence?.analystDelivery?.stride })
      return { progressEvents: [await start('stride_analyst'), await done('stride_analyst', state.strideThreats.length)] }
    }
    if (!state.architectureData || !state.config.enabledAnalysts.includes('stride')) {
      await emitPhaseOutput({ phase: 'stride_analyst', threats: [] })
      return { strideThreats: [] }
    }
    const eStart = await start('stride_analyst')
    let strideThreats: RawThreat[]
    try {
      strideThreats = await runPhase('stride_analyst', () =>
        runStrideAnalyst(
          analystLLM,
          ragTools.STRIDE_TOOLS,
          state.architectureData!,
          signal,
          reviewerLearning,
          quickLLM,
        ), state.architectureData!
      )
    } catch (err) {
      await rethrowIfCancelled(err)
      const wrapped = new MandatoryAnalystError('StrideAnalyst', err)
      const eErr = mkEvent('stride_analyst', 'error')
      await emitProgress(eErr)
      await emitPhaseOutput({ phase: 'stride_analyst', degraded: true, error: wrapped.message })
      options?.abortPipeline?.(wrapped)
      throw wrapped
    }
    // Outside the try/catch: a non-abort error here (e.g. a transient DB error
    // inside checkCancelled's lookup) must propagate as a real node failure,
    // not get silently swallowed and misreported as "StrideAnalyst failed".
    await checkCancelled()
    await emitPhaseOutput({ phase: 'stride_analyst', threats: strideThreats, sourceDelivery: state.architectureData?.sourceEvidence?.analystDelivery?.stride })
    return { strideThreats, sourceDelivery: { stride: state.architectureData?.sourceEvidence?.analystDelivery?.stride ?? [] }, progressEvents: [eStart, await done('stride_analyst', strideThreats.length)] }
  })

  graph.addNode('pasta_analyst', async (state: GraphState) => {
    await checkCancelled()
    // Seeded by a resumed run: reuse instead of paying for this analyst again.
    if (state.resumedPhases.includes('pasta_analyst') && hasAnalystDelivery(state.architectureData, 'pasta')) {
      log('pasta_analyst', 'done', `reused ${state.pastaThreats.length} threats from checkpoint`)
      await emitPhaseOutput({ phase: 'pasta_analyst', threats: state.pastaThreats, sourceDelivery: state.architectureData?.sourceEvidence?.analystDelivery?.pasta })
      return { progressEvents: [await start('pasta_analyst'), await done('pasta_analyst', state.pastaThreats.length)] }
    }
    if (!state.architectureData || !state.config.enabledAnalysts.includes('pasta')) {
      await emitPhaseOutput({ phase: 'pasta_analyst', threats: [] })
      return { pastaThreats: [] }
    }
    const eStart = await start('pasta_analyst')
    let pastaThreats: RawThreat[]
    try {
      pastaThreats = await runPhase('pasta_analyst', () =>
        runPastaAnalyst(
          analystLLM,
          ragTools.PASTA_TOOLS,
          state.architectureData!,
          signal,
          reviewerLearning,
          quickLLM,
        ), state.architectureData!
      )
    } catch (err) {
      await rethrowIfCancelled(err)
      const wrapped = new MandatoryAnalystError('PastaAnalyst', err)
      const eErr = mkEvent('pasta_analyst', 'error')
      await emitProgress(eErr)
      await emitPhaseOutput({ phase: 'pasta_analyst', degraded: true, error: wrapped.message })
      options?.abortPipeline?.(wrapped)
      throw wrapped
    }
    await checkCancelled()
    await emitPhaseOutput({ phase: 'pasta_analyst', threats: pastaThreats, sourceDelivery: state.architectureData?.sourceEvidence?.analystDelivery?.pasta })
    return { pastaThreats, sourceDelivery: { pasta: state.architectureData?.sourceEvidence?.analystDelivery?.pasta ?? [] }, progressEvents: [eStart, await done('pasta_analyst', pastaThreats.length)] }
  })

  graph.addNode('attack_tree_analyst', async (state: GraphState) => {
    await checkCancelled()
    // Seeded by a resumed run: reuse instead of paying for this analyst again.
    if (state.resumedPhases.includes('attack_tree_analyst') && hasAnalystDelivery(state.architectureData, 'attack_tree')) {
      log('attack_tree_analyst', 'done', `reused ${state.attackTreeThreats.length} threats from checkpoint`)
      await emitPhaseOutput({ phase: 'attack_tree_analyst', threats: state.attackTreeThreats, sourceDelivery: state.architectureData?.sourceEvidence?.analystDelivery?.attack_tree })
      return { progressEvents: [await start('attack_tree_analyst'), await done('attack_tree_analyst', state.attackTreeThreats.length)] }
    }
    if (!state.architectureData || !state.config.enabledAnalysts.includes('attack_tree')) {
      await emitPhaseOutput({ phase: 'attack_tree_analyst', threats: [] })
      return { attackTreeThreats: [] }
    }
    const eStart = await start('attack_tree_analyst')
    let attackTreeThreats: RawThreat[]
    try {
      attackTreeThreats = await runPhase('attack_tree_analyst', () =>
        runAttackTreeAnalyst(
          analystLLM,
          ragTools.ATTACK_TREE_TOOLS,
          state.architectureData!,
          signal,
          reviewerLearning,
          quickLLM,
        ), state.architectureData!
      )
    } catch (err) {
      await rethrowIfCancelled(err)
      const wrapped = new MandatoryAnalystError('AttackTreeAnalyst', err)
      const eErr = mkEvent('attack_tree_analyst', 'error')
      await emitProgress(eErr)
      await emitPhaseOutput({ phase: 'attack_tree_analyst', degraded: true, error: wrapped.message })
      options?.abortPipeline?.(wrapped)
      throw wrapped
    }
    await checkCancelled()
    await emitPhaseOutput({ phase: 'attack_tree_analyst', threats: attackTreeThreats, sourceDelivery: state.architectureData?.sourceEvidence?.analystDelivery?.attack_tree })
    return { attackTreeThreats, sourceDelivery: { attack_tree: state.architectureData?.sourceEvidence?.analystDelivery?.attack_tree ?? [] }, progressEvents: [eStart, await done('attack_tree_analyst', attackTreeThreats.length)] }
  })

  // ── Phase III: Pre-dedup ───────────────────────────────────────────────────
  graph.addNode('pre_dedup', async (state: GraphState) => {
    await checkCancelled()
    if (state.architectureData) {
      if (state.architectureData.sourceEvidence) state.architectureData.sourceEvidence.analystDelivery = { ...state.architectureData.sourceEvidence.analystDelivery, ...state.sourceDelivery }
      await emitPhaseOutput({ phase: 'architecture_parser', architecture: state.architectureData })
      assertAnalystCoverage(state.architectureData, state.config.enabledAnalysts)
    }

    if (state.resumedPhases.includes('pre_dedup')) {
      log('pre_dedup', 'done', `reused ${state.threatsKept.length} threats from checkpoint`)
      await emitPhaseOutput({
        phase: 'pre_dedup',
        threatsKept: state.threatsKept,
        filteredCount: state.filteredCount ?? 0,
      })
      return { progressEvents: [await start('pre_dedup'), await done('pre_dedup', state.threatsKept.length)] }
    }
    const eStart = await start('pre_dedup')
    const allRaw: RawThreat[] = [
      ...(state.strideThreats ?? []),
      ...(state.pastaThreats ?? []),
      ...(state.attackTreeThreats ?? []),
    ].map((threat, index) => ({
      ...threat,
      candidateId: threat.candidateId ?? `${threat.methodology}-${String(index + 1).padStart(2, '0')}`,
      methodologies: threat.methodologies ?? [threat.methodology],
    }))
    const scopedRaw = inScopeCandidates(allRaw, state.architectureData)
    const { kept, filteredCount: confidenceAndDuplicateCount, stats } = await runPhase('pre_dedup', async () =>
      deduplicateRawThreats(scopedRaw, {
        // The pipeline's single confidence gate. Post-validation nodes do NOT
        // re-filter by confidence (see dread_validator node comment).
        confidenceThreshold: config.pipeline.threatConfidenceThreshold,
        embedBatch: createOllamaBatchEmbedFn(config),
      })
    )
    const filteredCount = confidenceAndDuplicateCount + allRaw.length - scopedRaw.length
    logger.info('pre_dedup completed', { audit: { eventType: 'pre_dedup', metadata: stats } })
    await emitPhaseOutput({ phase: 'pre_dedup', threatsKept: kept, filteredCount })
    return {
      threatsKept: kept,
      filteredCount,
      progressEvents: [eStart, await done('pre_dedup', kept.length)],
    }
  })

  // ── Phase IV: Debate ───────────────────────────────────────────────────────
  graph.addNode('debate', async (state: GraphState) => {
    await checkCancelled()
    const kept = state.threatsKept ?? []

    if (state.resumedPhases.includes('debate')) {
      log('debate', 'done', `reused ${state.debateRounds.length} rounds from checkpoint`)
      await emitPhaseOutput({ phase: 'debate', debateRounds: state.debateRounds })
      return { progressEvents: [await start('debate'), await done('debate', state.debateRounds.length)] }
    }

    if (kept.length === 0) {
      await emitPhaseOutput({ phase: 'debate', debateRounds: [] })
      return { debateRounds: [] }
    }

    const eStart = await start('debate')

    // Debate the highest-confidence kept threats (cap for cost control)
    const debateCap = Math.min(kept.length, debateProfile.candidateCap)
    const threatsForDebate: DebateCandidate[] = kept
      .slice()
      .sort((a, b) => b.confidenceScore - a.confidenceScore)
      .slice(0, debateCap)
      .map((t, i) => ({
        ...t,
        draftId: `DRAFT-${i + 1}`,
      }))

    let rounds: DebateRound[] = [...(state.debateRounds ?? [])]
    const batchErrors: string[] = []
    const maxRounds = state.config.maxDebateRounds ?? 3
    // Source relevance depends on the stable batch, not on dialogue state.
    // Reuse one reviewed architecture across rounds instead of paying the same
    // large-context SourceReview call for every Red/Blue pair.
    const debateArchitectureCache = new Map<string, Promise<ArchitectureData>>()
    // Debate concurrency is tuned independently from synthesis because local
    // and hosted providers have different latency and throughput constraints.
    const batchConcurrency = debateProfile.batchConcurrency
    try {
      rounds = await runDebateSession({
        roundCount: maxRounds,
        previousRounds: rounds,
        runRound: async (i, previousRounds, isFinalRound) => {
          await checkCancelled()
          const previous = previousRounds[previousRounds.length - 1]
          const replayThreats = debateProfile.replayAgreedFindings || !previous
            ? threatsForDebate
            : candidatesNeedingReplay(threatsForDebate, previous)
          console.log(`[pipeline] debate round ${i}/${maxRounds}: Red then Blue (${replayThreats.length} of ${threatsForDebate.length} candidates)`)
          if (replayThreats.length === 0 && previous) {
            return mergeReplayedDebateRound({
              roundNumber: i,
              isFinalRound,
              orderedDraftIds: threatsForDebate.map((threat) => threat.draftId),
              previous,
            })
          }
          const live = await runPhase('debate', () => runDebateRound({
            redLLM: strideLLM,
            blueLLM,
            evidenceLLM: quickLLM,
            // Ollama: deep judge (quality-max). Kimi: quick (k2.6); a contested
            // close should not reopen K3 high-reasoning stalls. Cursor: quick
            // unless that agent opts the deep model in here.
            judgeLLM: effectiveConfig.llm.provider === 'ollama' ? deepLLM : quickLLM,
            tools: { red: ragTools.RED_TEAM_TOOLS, blue: ragTools.BLUE_TEAM_TOOLS },
            threats: replayThreats,
            previousRounds,
            roundNumber: i,
            isFinalRound,
            architecture: state.architectureData,
            architectureCache: debateArchitectureCache,
            profile: debateProfile,
            batchSize: debateProfile.batchSize,
            batchConcurrency,
            signal,
            onBatchError: (message) => batchErrors.push(message),
          }), undefined, {
            count: chunkDebateBatches(replayThreats, debateProfile.batchSize).length,
            concurrency: batchConcurrency,
          })
          if (!debateProfile.replayAgreedFindings && previous) {
            return mergeReplayedDebateRound({
              roundNumber: i,
              isFinalRound,
              orderedDraftIds: threatsForDebate.map((threat) => threat.draftId),
              previous,
              live,
            })
          }
          return live
        },
        onRound: async completedRounds => {
          rounds = completedRounds
          // Persist the complete pair before allowing either next turn to start.
          await emitPhaseOutput({ phase: 'debate', debateRounds: rounds.slice(), complete: false })
          await checkCancelled()
        },
      })
    } catch (err) {
      await rethrowIfCancelled(err)
      // Debate refines threats that already exist; losing it must never
      // discard them. Keep the rounds gathered so far and move to synthesis.
      const message = `Debate: ${toPublicErrorMessage(err, 'debate round failed')}`
      const eErr = mkEvent('debate', 'error')
      await emitProgress(eErr)
      await emitPhaseOutput({ phase: 'debate', degraded: true, error: message })
      return {
        debateRounds: rounds,
        errors: [message],
        degradedAgents: [{ agent: 'Debate', error: message, at: Date.now() }],
        progressEvents: [eStart, eErr],
      }
    }

    const unresolved = latestDebateAssessments(rounds).filter(item => item.finalVerdict === 'unresolved')
    if (unresolved.length) batchErrors.push(`Debate remains unresolved for ${unresolved.length} candidate(s): ${unresolved.map(item => item.draftId).join(', ')}. No supported debate verdict is available for them.`)
    await emitPhaseOutput({ phase: 'debate', debateRounds: rounds, complete: unresolved.length === 0 })
    for (const error of batchErrors) await emitPhaseOutput({ phase: 'debate', degraded: true, error })
    return {
      debateRounds: rounds,
      errors: batchErrors,
      degradedAgents: batchErrors.map((error) => ({ agent: 'Debate', error, at: Date.now() })),
      progressEvents: [eStart, await done('debate', rounds.length)],
    }
  })

  // ── Phase V: Synthesis ─────────────────────────────────────────────────────
  graph.addNode('threat_synthesizer', async (state: GraphState) => {
    await checkCancelled()
    if (state.resumedPhases.includes('threat_synthesizer')) {
      const threats = state.threatsPreDedup ?? []
      log('threat_synthesizer', 'done', `reused ${threats.length} threats from checkpoint`)
      await emitPhaseOutput({ phase: 'threat_synthesizer', threatsPreDedup: threats })
      return { progressEvents: [await start('threat_synthesizer'), await done('threat_synthesizer', threats.length)] }
    }
    if (!state.architectureData) throw new Error('Missing architecture data for synthesis')
    const eStart = await start('threat_synthesizer')
    const kept = state.threatsKept ?? []
    // Debate candidates have stable IDs. Invalid verdicts are enforced before
    // synthesis, while refinements remain in the transcript supplied to it.
    const finalVerdicts = new Map<string, DebateRound['threatAssessments'][number]>()
    for (const round of state.debateRounds ?? []) {
      for (const assessment of round.threatAssessments) finalVerdicts.set(assessment.draftId, assessment)
    }
    const debatedByDraft = kept
      .slice().sort((a, b) => b.confidenceScore - a.confidenceScore).slice(0, Math.min(kept.length, debateProfile.candidateCap))
      .map((threat, index) => ({ threat, draftId: `DRAFT-${index + 1}` }))
    const invalidDrafts = new Set([...finalVerdicts.values()].filter((assessment) => assessment.disposition === 'invalid' || assessment.finalVerdict === 'invalid').map((assessment) => assessment.draftId))
    const threatsForSynthesis = kept.filter((threat) => !debatedByDraft.some((candidate) => candidate.threat === threat && invalidDrafts.has(candidate.draftId))).map(threat => {
      const draft = debatedByDraft.find(candidate => candidate.threat === threat)
      const assessment = draft ? finalVerdicts.get(draft.draftId) : undefined
      return { ...threat, disposition: assessment?.disposition ?? 'conditional' as const,
        preconditions: assessment && ['conditional', 'control_verification_needed'].includes(assessment.disposition ?? '') ? [assessment.notes] : threat.preconditions }
    })
    let threats: UnifiedThreat[]
    const batchErrors: string[] = []
    try {
      threats = await runPhase('threat_synthesizer', () => runThreatSynthesizer(
        quickLLM,
        ragTools.SYNTHESIS_TOOLS,
        threatsForSynthesis,
        state.debateRounds ?? [],
        state.architectureData!,
        state.config.targetThreats ?? 15,
        signal,
        reviewerLearning,
        providerBatchConcurrency(effectiveConfig.llm.provider),
        synthesisEmissionLLM,
        (message) => batchErrors.push(message),
      )
      )
    } catch (err) {
      await rethrowIfCancelled(err)
      // Fall back to the deterministic mapping so the analyst findings survive.
      // These threats carry derived DREAD scores and stay flagged as degraded,
      // so they are never presented as if synthesis had reviewed them.
      const message = `ThreatSynthesizer: ${toPublicErrorMessage(err, 'synthesis failed')}; analyst findings kept unsynthesized`
      const eErr = mkEvent('threat_synthesizer', 'error')
      await emitProgress(eErr)
      await emitPhaseOutput({ phase: 'threat_synthesizer', degraded: true, error: message })
      const fallback = threatsForSynthesis.map(rawToUnified)
      return {
        threatsPreDedup: fallback,
        errors: [message],
        degradedAgents: [{ agent: 'ThreatSynthesizer', error: message, at: Date.now() }],
        progressEvents: [eStart, eErr],
      }
    }
    await checkCancelled()
    await emitPhaseOutput({ phase: 'threat_synthesizer', threatsPreDedup: threats })
    for (const error of batchErrors) await emitPhaseOutput({ phase: 'threat_synthesizer', degraded: true, error })
    return {
      threatsPreDedup: threats,
      errors: batchErrors,
      degradedAgents: batchErrors.map((error) => ({ agent: 'ThreatSynthesizer', error, at: Date.now() })),
      progressEvents: [eStart, await done('threat_synthesizer', threats.length)],
    }
  })

  // ── Phase VI: DREAD validation ─────────────────────────────────────────────
  graph.addNode('dread_validator', async (state: GraphState) => {
    await checkCancelled()
    if (state.resumedPhases.includes('dread_validator')) {
      const threats = state.threatsFinal ?? []
      log('dread_validator', 'done', `reused ${threats.length} threats from checkpoint`)
      await emitPhaseOutput({
        phase: 'dread_validator',
        threatsFinal: threats,
        filteredCount: state.filteredCount ?? 0,
      })
      return { progressEvents: [await start('dread_validator'), await done('dread_validator', threats.length)] }
    }
    if (!state.threatsPreDedup?.length) {
      await emitPhaseOutput({
        phase: 'dread_validator',
        threatsFinal: [],
        filteredCount: state.filteredCount ?? 0,
      })
      return { threatsFinal: [] }
    }
    const eStart = await start('dread_validator')
    let validated: UnifiedThreat[]
    const batchErrors: string[] = []
    try {
      validated = await runPhase('dread_validator', () =>
        runDreadValidator(quickLLM, ragTools.VALIDATOR_TOOLS, state.threatsPreDedup!, {
          signal,
          concurrency: config.pipeline.validatorConcurrency,
          maxRetries: effectiveConfig.llm.provider === 'ollama' ? 2 : 1,
          evidenceMaxRetries: effectiveConfig.llm.provider === 'ollama' ? 2 : 1,
          // Without this the ceiling rules in the validator prompt have no
          // facts to apply and the only available move is to inflate.
          context: buildValidatorContext({
            architecture: state.architectureData,
            debateRounds: state.debateRounds ?? [],
            candidateIdByDraftId: candidateIdsByDraft(state, debateProfile.candidateCap),
          }),
          onBatchError: (message) => batchErrors.push(message),
        }), undefined, {
        count: Math.ceil(state.threatsPreDedup!.length / VALIDATOR_BATCH_SIZE),
        concurrency: validatorConcurrency(quickLLM, config.pipeline.validatorConcurrency),
      })
    } catch (err) {
      await rethrowIfCancelled(err)
      // Validation only re-scores threats that already exist. Ship them with
      // their synthesis scores rather than losing the entire run.
      const message = `DreadValidator: ${toPublicErrorMessage(err, 'validation failed')}; threats kept with unvalidated scores`
      const eErr = mkEvent('dread_validator', 'error')
      await emitProgress(eErr)
      await emitPhaseOutput({ phase: 'dread_validator', degraded: true, error: message })
      return {
        threatsFinal: state.threatsPreDedup ?? [],
        filteredCount: 0,
        errors: [message],
        degradedAgents: [{ agent: 'DreadValidator', error: message, at: Date.now() }],
        progressEvents: [eStart, eErr],
      }
    }
    await checkCancelled()
    // Evidence policy ONLY, not a confidence filter. Confidence is gated once,
    // upstream in pre_dedup (dedup.ts with config.pipeline.threatConfidenceThreshold).
    // This drops critical/high threats that lost their evidence/traceability
    // anchor during synthesis/validation; previously this node ALSO re-filtered
    // by confidence (0.5/0.65) with different logic than pre-dedup, removed.
    const { kept: evidenceKept, filteredCount } = state.config.requireEvidenceForHighPriority
      ? filterByEvidencePolicy(validated)
      : { kept: validated, filteredCount: 0 }
    const kept = applyControlAwareValidation(
      evidenceKept,
      state.architectureData!,
      state.config.targetThreats ?? 15,
    )
    const totalFiltered = (state.filteredCount ?? 0) + filteredCount
    options?.ragTrace?.recordCandidateOutcomes(state.threatsKept ?? [], kept)
    await emitPhaseOutput({ phase: 'dread_validator', threatsFinal: kept, filteredCount: totalFiltered })
    for (const error of batchErrors) await emitPhaseOutput({ phase: 'dread_validator', degraded: true, error })
    return {
      threatsFinal: kept,
      filteredCount: totalFiltered,
      errors: batchErrors,
      degradedAgents: batchErrors.map((error) => ({ agent: 'DreadValidator', error, at: Date.now() })),
      progressEvents: [eStart, await done('dread_validator', kept.length)],
    }
  })

  // ── Edges (executionMode controls analyst fan-out) ─────────────────────────
  const g = graph as unknown as { addEdge(from: string | string[], to: string): void }

  g.addEdge(START, 'architecture_parser')
  wireAnalystEdges(g, executionMode)
  g.addEdge('pre_dedup', 'debate')
  g.addEdge('debate', 'threat_synthesizer')
  g.addEdge('threat_synthesizer', 'dread_validator')
  g.addEdge('dread_validator', END)

  logger.info('Threat model graph compiled', {
    audit: {
      eventType: 'pipeline_graph_compiled',
      metadata: {
        executionMode,
        executionProfile: requestConfig?.executionProfile ?? 'provider_optimized',
        provider: requestedProvider,
        allowedProviders,
      },
    },
  })

  return graph.compile()
}
