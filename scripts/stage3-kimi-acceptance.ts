/** Controlled Stage 3 Kimi acceptance. Fictional review service only. */
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { getConfig } from '../lib/config'
import { getLLM } from '../lib/llm/factory'
import { configuredRates, emptyUsage, estimateCost, runWithUsage } from '../lib/llm/usage'
import { heldReservationUsd, UnpricedModelError } from '../lib/llm/cost-reservation'
import { runWithModelCallLimit } from '../lib/llm/call-accounting'
import { runDebateRound } from '../lib/agents/debate'
import { runDebateSession } from '../lib/agents/debate-session'
import { evaluateStage2Run } from '../lib/evaluation/stage2-acceptance'
import {
  acceptanceDiagnostic,
  runAcceptanceAttempt,
  writeAcceptanceReport,
} from '../lib/evaluation/acceptance-lifecycle'
import {
  STAGE3_MAX_CALLS,
  STAGE3_MAX_USD,
  buildStage3Fixture,
} from '../lib/evaluation/stage3-kimi'
import type { DebateRound } from '../lib/models/types'

/** Keep the existing acceptance wall clock bounded; this does not enlarge call timeouts. */
const STAGE3_DEADLINE_MS = 12 * 60_000

function transcriptNeedsTruncation(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 2_000
  if (Array.isArray(value)) return value.length > 100 || value.some(transcriptNeedsTruncation)
  if (value && typeof value === 'object') return Object.values(value).some(transcriptNeedsTruncation)
  return false
}

function requirePrices(model: string): void {
  if (!configuredRates()[model]) throw new UnpricedModelError(model)
}

async function main(): Promise<boolean> {
  // Load dotenv before resolving output paths, models, or limits.
  loadEnv({ path: '.env.local', quiet: true })
  const output = resolve(process.env.STAGE3_OUTPUT ?? 'output/qa/stage3/kimi-acceptance.json')
  const configuredLimit = Number(process.env.MAX_RUN_COST_USD)
  process.env.MAX_RUN_COST_USD = String(Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.min(STAGE3_MAX_USD, configuredLimit) : STAGE3_MAX_USD)
  const usage = emptyUsage()
  const callLimit = { maxCalls: STAGE3_MAX_CALLS, started: 0 }
  let model = process.env.STAGE3_MODEL ?? 'unknown'
  let rounds: DebateRound[] = []
  const errors: string[] = []

  try {
    const config = getConfig()
    if (!config.llm.kimiApiKey) {
      const document = {
        stage: 3,
        scope: 'debate-only',
        synthetic: true,
        zeroDataRetention: false,
        liveCloud: true,
        cloudCallsMade: false,
        status: 'blocked' as const,
        blocked: true,
        passed: false,
        reason: 'MOONSHOT_API_KEY / KIMI_API_KEY is not configured.',
        attemptedCalls: 0,
        maxCalls: STAGE3_MAX_CALLS,
        maxUsd: STAGE3_MAX_USD,
        consecutiveRuns: [],
      }
      await writeAcceptanceReport(output, document)
      console.error(JSON.stringify(document, null, 2))
      return false
    }

    model = process.env.STAGE3_MODEL ?? config.llm.kimiQuickModel
    requirePrices(model)
    const llm = getLLM({
      ...config,
      llm: { ...config.llm, provider: 'kimi' },
    }, 'quick', false, model)

    const { architecture, cases, foreignPassage } = buildStage3Fixture()
    const attempt = await runAcceptanceAttempt({
      timeoutMs: STAGE3_DEADLINE_MS,
      run: (signal) => runWithUsage(usage, () => runWithModelCallLimit(callLimit, () => runDebateSession({
        roundCount: 2,
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
          onBatchError: (message) => { errors.push(message); throw new Error(message) },
        }),
      }))),
    })
    const evaluation = evaluateStage2Run({
      rounds,
      cases,
      errors,
      source: architecture.sourceEvidence!,
      foreignPassage,
    })
    const cost = estimateCost(usage)
    const unconfirmedCostUsd = heldReservationUsd(usage)
    const budgetPassed = callLimit.started <= STAGE3_MAX_CALLS
      && cost.totalUsd <= STAGE3_MAX_USD
      && unconfirmedCostUsd === 0
    const status = attempt.status === 'timed_out'
      ? 'timed_out' as const
      : attempt.status === 'failed' || !budgetPassed || !evaluation.passed
        ? 'failed' as const
        : 'completed' as const
    const passed = status === 'completed'
    const document = {
      stage: 3,
      scope: 'debate-only',
      synthetic: true,
      zeroDataRetention: false,
      liveCloud: true,
      cloudCallsMade: callLimit.started > 0,
      provider: 'kimi',
      model,
      status,
      blocked: false,
      maxCalls: STAGE3_MAX_CALLS,
      attemptedCalls: callLimit.started,
      maxUsd: STAGE3_MAX_USD,
      passed,
      unconfirmedCostUsd,
      durationMs: attempt.durationMs,
      ...(attempt.error ? { error: attempt.error } : {}),
      usage: {
        calls: usage.calls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalUsd: cost.totalUsd,
        byAgent: usage.byAgent,
      },
      errors: errors.map((error) => acceptanceDiagnostic(error).message),
      issues: evaluation.issues.map((issue) => acceptanceDiagnostic(issue).message),
      rounds: rounds.length,
      transcript: rounds,
      transcriptTruncated: transcriptNeedsTruncation(rounds),
      transcriptLimits: { maxRounds: 100, maxStringChars: 2_000 },
      cases: evaluation.cases,
    }
    await writeAcceptanceReport(output, document)
    console.log(JSON.stringify({
      passed,
      status,
      output,
      calls: usage.calls,
      totalUsd: cost.totalUsd,
      cases: evaluation.cases.map((item) => [item.kind, item.passed]),
    }))
    return passed
  } catch (error) {
    const cost = estimateCost(usage)
    const document = {
      stage: 3,
      scope: 'debate-only',
      synthetic: true,
      zeroDataRetention: false,
      liveCloud: true,
      cloudCallsMade: callLimit.started > 0,
      provider: 'kimi',
      model,
      status: 'failed' as const,
      blocked: false,
      passed: false,
      maxCalls: STAGE3_MAX_CALLS,
      attemptedCalls: callLimit.started,
      maxUsd: STAGE3_MAX_USD,
      error: acceptanceDiagnostic(error),
      usage: {
        calls: usage.calls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalUsd: cost.totalUsd,
        unconfirmedCostUsd: heldReservationUsd(usage),
        byAgent: usage.byAgent,
      },
      rounds: rounds.length,
      transcript: rounds,
      transcriptTruncated: transcriptNeedsTruncation(rounds),
      transcriptLimits: { maxRounds: 100, maxStringChars: 2_000 },
      errors: errors.map((item) => acceptanceDiagnostic(item).message),
    }
    await writeAcceptanceReport(output, document).catch((writeError) => {
      console.error(`Could not persist Stage 3 diagnostic report: ${acceptanceDiagnostic(writeError).message}`)
    })
    console.error(JSON.stringify(document, null, 2))
    return false
  }
}

main().then((passed) => {
  if (!passed) process.exitCode = 1
})
