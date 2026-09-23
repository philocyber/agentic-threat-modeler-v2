/** Bounded local Stage 2 acceptance. Synthetic review service only; no cloud APIs. */
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { getConfig } from '../lib/config'
import { getLLM } from '../lib/llm/factory'
import { emptyUsage, runWithUsage } from '../lib/llm/usage'
import { runDebateRound } from '../lib/agents/debate'
import { runDebateSession } from '../lib/agents/debate-session'
import {
  acceptanceDiagnostic,
  runAcceptanceAttempt,
  type AcceptanceRun,
  type AcceptanceRunStatus,
  withResponseCacheDisabled,
  writeAcceptanceReport,
} from '../lib/evaluation/acceptance-lifecycle'
import {
  buildStage2Fixture,
  evaluateStage2Run,
  type Stage2RunEvaluation,
} from '../lib/evaluation/stage2-acceptance'
import type { DebateRound } from '../lib/models/types'

const RUNS = 2
/** Wall clock for six candidates at the existing per-call structured timeout. */
const RUN_DEADLINE_MS = 12 * 60_000

type Probe = {
  endpoint: string
  reachable: boolean
  models: string[]
  hasModel: boolean
}

type CompletedRun = {
  evaluation: Stage2RunEvaluation
  usage: ReturnType<typeof emptyUsage>
  errors: string[]
  rounds: number
  transcript: DebateRound[]
}

type Stage2Attempt = AcceptanceRun<CompletedRun>

function transcriptNeedsTruncation(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 2_000
  if (Array.isArray(value)) return value.length > 100 || value.some(transcriptNeedsTruncation)
  if (value && typeof value === 'object') return Object.values(value).some(transcriptNeedsTruncation)
  return false
}

async function probeOllama(endpoint: string, model: string): Promise<Probe> {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return { endpoint, reachable: false, models: [], hasModel: false }
    const body = await response.json() as { models?: Array<{ name?: string; model?: string }> }
    const models = (body.models ?? []).map((item) => item.name ?? item.model ?? '').filter(Boolean)
    return { endpoint, reachable: true, models, hasModel: models.includes(model) || models.some((name) => name.startsWith(`${model}:`)) }
  } catch {
    return { endpoint, reachable: false, models: [], hasModel: false }
  }
}

async function oneRun(llm: ReturnType<typeof getLLM>): Promise<Stage2Attempt> {
  const { architecture, cases, foreignPassage } = buildStage2Fixture()
  const usage = emptyUsage()
  const errors: string[] = []
  let rounds: DebateRound[] = []
  const attempt = await runAcceptanceAttempt({
    timeoutMs: RUN_DEADLINE_MS,
    run: (signal) => runWithUsage(usage, () => runDebateSession({
      roundCount: 2,
      // Persist every completed pair in memory so a later failure still has
      // the useful artifacts needed for the diagnostic report.
      onRound: async (completed) => { rounds = completed },
      runRound: (roundNumber, previousRounds, isFinalRound) => runDebateRound({
        redLLM: llm,
        blueLLM: llm,
        judgeLLM: llm,
        evidenceLLM: llm,
        tools: { red: [], blue: [] },
        threats: cases.map((item) => item.candidate),
        architecture,
        previousRounds,
        roundNumber,
        isFinalRound,
        batchConcurrency: 1,
        signal,
        onBatchError: (message) => errors.push(message),
      }),
    })),
  })
  const evaluation = evaluateStage2Run({
    rounds,
    cases,
    errors,
    source: architecture.sourceEvidence!,
    foreignPassage,
  })
  const completed: CompletedRun = {
    evaluation,
    usage,
    errors,
    rounds: rounds.length,
    transcript: rounds,
  }
  return { ...attempt, value: completed }
}

function runDocument(run: Stage2Attempt, index: number) {
  const completed = run.value
  return {
    run: index + 1,
    status: run.status,
    startedAt: run.startedAt,
    passed: run.status === 'completed' && Boolean(completed?.evaluation.passed),
    durationMs: run.durationMs,
    ...(run.error ? { error: run.error } : {}),
    ...(completed ? {
      rounds: completed.rounds,
      usage: {
        calls: completed.usage.calls,
        inputTokens: completed.usage.inputTokens,
        outputTokens: completed.usage.outputTokens,
        byAgent: completed.usage.byAgent,
      },
      errors: completed.errors.map((error) => acceptanceDiagnostic(error).message),
      issues: completed.evaluation.issues.map((issue) => acceptanceDiagnostic(issue).message),
      cases: completed.evaluation.cases,
      transcript: completed.transcript,
      transcriptTruncated: transcriptNeedsTruncation(completed.transcript),
      transcriptLimits: { maxRounds: 100, maxStringChars: 2_000 },
    } : {}),
  }
}

function overallStatus(runs: Stage2Attempt[]): AcceptanceRunStatus {
  if (runs.some((run) => run.status === 'timed_out')) return 'timed_out'
  if (runs.length === RUNS && runs.every((run) => run.status === 'completed' && run.value?.evaluation.passed)) return 'completed'
  return 'failed'
}

function progressDocument(params: {
  status: 'running' | 'blocked' | AcceptanceRunStatus
  passed: boolean
  model: string
  endpoint: string
  probe?: Probe
  runs: Stage2Attempt[]
  error?: ReturnType<typeof acceptanceDiagnostic>
}) {
  return {
    stage: 2,
    scope: 'debate-only',
    synthetic: true,
    liveCloud: false,
    status: params.status,
    blocked: params.status === 'blocked',
    passed: params.passed,
    model: params.model,
    endpoint: params.endpoint,
    ...(params.probe ? { probe: params.probe } : {}),
    ...(params.error ? { error: params.error } : {}),
    consecutiveRuns: params.runs.map(runDocument),
  }
}

async function main(): Promise<boolean> {
  // Resolve every env-dependent value after dotenv has had a chance to load.
  loadEnv({ path: '.env.local', quiet: true })
  const endpoint = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
  const model = process.env.STAGE2_MODEL ?? getConfig().llm.ollamaDeepModel
  const output = resolve(process.env.STAGE2_OUTPUT ?? 'output/qa/stage2/local-acceptance.json')
  const runs: Stage2Attempt[] = []
  let probe: Probe | undefined

  try {
    probe = await probeOllama(endpoint, model)
    if (!probe.reachable || !probe.hasModel) {
      const document = {
        ...progressDocument({ status: 'blocked', passed: false, probe, model, endpoint, runs }),
        recovery: probe.reachable
          ? [`ollama pull ${model}`, 'Re-run: node node_modules/tsx/dist/cli.mjs scripts/stage2-local-acceptance.ts']
          : ['Start Ollama (ollama serve) on the configured base URL.', `Then ollama pull ${model}`],
        consecutiveRuns: [],
      }
      await writeAcceptanceReport(output, document)
      console.error(JSON.stringify(document, null, 2))
      return false
    }

    const config = getConfig()
    const llm = getLLM({
      ...config,
      llm: { ...config.llm, provider: 'ollama', ollamaBaseUrl: endpoint },
    }, 'deep', false, model)

    for (let index = 0; index < RUNS; index += 1) {
      console.error(`stage2 run ${index + 1}/${RUNS} model=${model}`)
      // A cache hit would make consecutive runs identical and would not test
      // two independent local generations.
      const run = await withResponseCacheDisabled(() => oneRun(llm))
      runs.push(run)
      // Leave a reviewable artifact before beginning another expensive run.
      await writeAcceptanceReport(output, progressDocument({
        status: run.status === 'completed' && run.value?.evaluation.passed ? 'running' : run.status,
        passed: false,
        model,
        endpoint,
        probe,
        runs,
      }))
      if (run.status !== 'completed' || !run.value?.evaluation.passed) break
    }

    const status = overallStatus(runs)
    const passed = status === 'completed'
    const consecutiveRuns = runs.map(runDocument)
    const document = { ...progressDocument({ status, passed, model, endpoint, probe, runs }), consecutiveRuns }
    await writeAcceptanceReport(output, document)
    console.log(JSON.stringify({ passed, status, output, durationMs: runs.map((run) => run.durationMs), cases: consecutiveRuns.map((run) => run.cases?.map((item) => [item.kind, item.passed]) ?? []) }))
    return passed
  } catch (error) {
    const diagnostic = acceptanceDiagnostic(error)
    const status = error instanceof Error && error.name === 'AcceptanceDeadlineError' ? 'timed_out' as const : 'failed' as const
    const document = progressDocument({
      status,
      passed: false,
      model,
      endpoint,
      ...(probe ? { probe } : {}),
      runs,
      error: diagnostic,
    })
    await writeAcceptanceReport(output, document).catch((writeError) => {
      console.error(`Could not persist Stage 2 diagnostic report: ${acceptanceDiagnostic(writeError).message}`)
    })
    console.error(JSON.stringify(document, null, 2))
    return false
  }
}

main().then((passed) => {
  if (!passed) process.exitCode = 1
})
