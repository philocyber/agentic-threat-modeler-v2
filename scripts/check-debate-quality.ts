/** Explicit, bounded local inference check. Does not create or change saved analyses. */
import { config as loadEnv } from 'dotenv'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getConfig } from '../lib/config'
import { getLLM } from '../lib/llm/factory'
import { runDebateRound } from '../lib/agents/debate'
import { runDebateSession } from '../lib/agents/debate-session'
import { isDebateFindingResolved } from '../lib/agents/debate-convergence'
import { createSourceEvidence } from '../lib/architecture/source-evidence'
import type { ArchitectureData, DebateCandidate } from '../lib/models/types'

async function main() {
  loadEnv({ path: '.env.local', quiet: true })
  const config = getConfig()
  const modelName = process.env.DEBATE_CHECK_MODEL ?? 'qwen3:8b'
  const llm = getLLM({ ...config, llm: { ...config.llm, provider: 'ollama',
    ollamaBaseUrl: 'http://127.0.0.1:11434' } }, 'deep', false, modelName)
  const source = `# ReviewDesk, synthetic review fixture
ReviewDesk imports support messages into draft investigation summaries. Imported text is untrusted.
The assistant cannot publish a summary: a human reviewer must approve publication.
The publishing service checks that the approver is a different authenticated employee from the draft author.
ReviewDesk has no payment service, payment endpoint or card data. It cannot initiate payments.
The source does not document a test that verifies whether reviewers notice inaccurate claims in summaries.`
  const architecture: ArchitectureData = {
    systemDescription: 'ReviewDesk support review workflow',
    components: [{ name: 'ReviewDesk', type: 'service', scope: 'internal' }],
    dataFlows: [], trustBoundaries: [], externalEntities: [], dataStores: [], apiEndpoints: [],
    deploymentInfo: '', mermaidDfd: '',
    techFlags: { hasAI: true, hasAuthSystem: true, hasDatabaseLayer: false, hasExternalIntegrations: false,
      hasFileStorage: false, hasKubernetes: false, hasMessageQueue: false, hasMicroservices: false },
    sourceEvidence: createSourceEvidence(source),
  }
  const threats: DebateCandidate[] = [
    { draftId: 'DRAFT-1', component: 'ReviewDesk', methodology: 'STRIDE', confidenceScore: 0.65,
      description: 'Untrusted support content may cause an inaccurate draft summary that a human reviewer overlooks.',
      impact: 'Incorrect investigation conclusions.', mitigation: 'Verify source claims during human review.',
      evidenceSources: [{ sourceType: 'rag', sourceName: 'Unrelated AutoRust example', excerpt: 'AutoRust uses signed release packages.' }] },
    { draftId: 'DRAFT-2', component: 'ReviewDesk', methodology: 'STRIDE', confidenceScore: 0.65,
      description: 'The ReviewDesk payment endpoint allows an unauthorized payment.',
      impact: 'Incorrect payment.', mitigation: 'Review payment authorization.', evidenceSources: [] },
  ]
  const started = Date.now()
  const errors: string[] = []
  const signal = AbortSignal.timeout(10 * 60_000)
  const rounds = await runDebateSession({ roundCount: 2,
    runRound: (roundNumber, previousRounds, isFinalRound) => runDebateRound({
      redLLM: llm, blueLLM: llm, judgeLLM: llm, evidenceLLM: llm,
      tools: { red: [], blue: [] }, threats, architecture, previousRounds, roundNumber, isFinalRound,
      batchConcurrency: 1, signal, onBatchError: message => errors.push(message),
    }) })
  const round = rounds.at(-1)!
  const first = round.threatAssessments.find(item => item.draftId === 'DRAFT-1')
  const second = round.threatAssessments.find(item => item.draftId === 'DRAFT-2')
  const passed = errors.length === 0 && rounds.length === 2 && rounds.every(item => item.threatAssessments.length === 2)
    && round.threatAssessments.every(isDebateFindingResolved)
    && rounds.every(item => item.threatAssessments.every(assessment => Boolean(assessment.redNotes?.trim())
      && Boolean(assessment.blueNotes?.trim()) && !assessment.redReplyNotes))
    && rounds[0]?.isFinalRound === false && rounds[0]?.judgeSummary === undefined
    && first?.finalVerdict !== 'invalid' && second?.finalVerdict === 'invalid'
  const path = resolve(process.env.DEBATE_CHECK_OUTPUT ?? '/tmp/agentic-tm-debate-local-check.json')
  await writeFile(path, JSON.stringify({ model: modelName, synthetic: true, liveRagRetrieval: false,
    durationMs: Date.now() - started, passed, errors, configuredRounds: 2, rounds }, null, 2))
  console.log(JSON.stringify({ passed, path, durationMs: Date.now() - started }))
  if (!passed) process.exitCode = 1
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
