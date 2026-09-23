import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessageChunk } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearConfigCache } from '@/lib/config'
import { createRunManifest } from '@/lib/runs/run-manifest'
import { claimPipelineRun, setPipelineWorkerInstanceId } from '@/lib/pipeline-cancellation'
import { executePipelineRun } from '@/lib/pipeline/execute-run'
import { createThreatModel, getThreatModel, listThreats } from '@/lib/storage/threat-models'
import { getRunArtifactText } from '@/lib/storage/artifacts'
import { closeAllWorkspaceStorage } from '@/lib/storage/context'
import { createLocalProject } from '@/lib/workspace/local-project'
import { runWithWorkspace } from '@/lib/workspace/context'
import type { AnalysisConfig } from '@/lib/models/types'
import { mapRowToUnifiedThreat } from '@/lib/db/helpers'
import { generateCSV } from '@/lib/agents/report-generator'

/**
 * This is deliberately a transport double, not a graph or agent double. The
 * real parser, three mandatory analysts, debate, synthesis, DREAD and storage
 * pipeline all run against the small source document below.
 */
const scriptedModel = new ChatOpenAI({ apiKey: 'offline-fixture', model: 'offline-fixture' })
const scriptedInvoke = vi.spyOn(scriptedModel, 'invoke')
const fetchGuard = vi.spyOn(globalThis, 'fetch')
const calls: string[] = []

vi.mock('@/lib/llm/factory', () => ({
  getLLM: () => scriptedModel,
  clearLLMCache: () => {},
}))

vi.mock('@/lib/embeddings/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/embeddings/client')>()
  return {
    ...actual,
    // Dedup remains real, but its normally remote Ollama embedding transport is
    // deterministic and local to this test process.
    createOllamaBatchEmbedFn: () => async (texts: string[]) => texts.map(() => [1, 0, 0]),
  }
})

vi.mock('@/lib/health/rag-status', () => ({
  // executePipelineRun probes readiness even when a run explicitly disables
  // retrieval, so keep that external health dependency offline as well.
  probeRagHealth: async () => ({
    status: 'down', usable: false, endpoint: 'offline://rag', issue: 'chroma_unreachable',
    reason: 'Offline acceptance fixture disables retrieval.', recovery: [], documentCount: null, pageIndexNodes: 0,
  }),
}))

const sourceDocument = `# DeskRelay
DeskRelay is an internal review application. Reviewers sign in through the Gateway and submit approval notes to the Review API over HTTPS.

## Processing
The Review API stores approval notes in the Review Database. The Gateway validates user sessions, but the document says callback signatures from the internal notification relay are not yet verified. Only the notification relay sends callbacks to the Review API.

## Controls
Transport encryption is enabled for the Gateway and Review API connection. Callback signature verification is not yet enabled; the team must verify the sender before accepting callback status changes.`

function architecture() {
  return {
    systemDescription: 'DeskRelay is an internal review application with a gateway, review API, database, and notification relay.',
    components: [
      { name: 'Gateway', type: 'gateway', scope: 'internal', technology: 'HTTPS', relationship: 'system', scopeEvidence: 'Reviewers sign in through the Gateway.' },
      { name: 'Review API', type: 'service', scope: 'internal', technology: 'TypeScript', relationship: 'system', scopeEvidence: 'The Review API stores approval notes.' },
      { name: 'Review Database', type: 'database', scope: 'internal', technology: 'SQLite', relationship: 'system', scopeEvidence: 'The Review API stores approval notes in the Review Database.' },
      { name: 'Notification Relay', type: 'service', scope: 'internal', technology: 'HTTPS', relationship: 'dependency', scopeEvidence: 'Only the notification relay sends callbacks to the Review API.' },
    ],
    dataFlows: [
      { from: 'Gateway', to: 'Review API', data: 'review sessions and approval notes', protocol: 'HTTPS' },
      { from: 'Review API', to: 'Review Database', data: 'approval notes', protocol: 'SQL' },
      { from: 'Notification Relay', to: 'Review API', data: 'callback status changes', protocol: 'HTTPS' },
    ],
    trustBoundaries: ['Reviewer session boundary', 'Notification callback boundary'],
    externalEntities: ['Reviewers'],
    dataStores: ['Review Database'],
    apiEndpoints: ['POST /callbacks/status'],
    deploymentInfo: 'Internal application deployment.',
    mermaidDfd: '',
    techFlags: { hasAI: false, hasMicroservices: false, hasKubernetes: false, hasAuthSystem: true, hasExternalIntegrations: false, hasDatabaseLayer: true, hasFileStorage: false, hasMessageQueue: false },
    detailedTopology: { securityConfigs: [
      { component: 'Gateway', configType: 'transport', isEnabled: true, details: 'HTTPS enabled to Review API' },
      { component: 'Review API', configType: 'callback', isEnabled: false, details: 'callback signature verification is not yet enabled' },
    ] },
  }
}

const evidence = [{ sourceType: 'architecture', sourceName: 'SRC-0002', excerpt: 'callback signatures from the internal notification relay are not yet verified' }]
const longDescription = 'The Review API accepts notification callback status changes before verifying the documented relay signature, so a callback delivery that is not authenticated could alter the approval state while the sender check remains unresolved.'

function analystThreat(methodology: 'STRIDE' | 'PASTA' | 'ATTACK_TREE') {
  return {
    component: 'Review API',
    description: longDescription,
    impact: 'Approval records could be changed incorrectly and require review before they are trusted.',
    mitigation: 'Verify relay callback signatures before accepting status changes and record verification failures.',
    confidenceScore: 0.82,
    evidenceSources: evidence,
    ...(methodology === 'STRIDE' ? { strideCategory: 'Tampering' } : {}),
    ...(methodology === 'PASTA' ? { attackerProfile: 'An unauthorized sender', attackVector: 'A callback status change received before sender verification', reasoning: 'The source records that signature verification is not yet enabled.' } : {}),
    ...(methodology === 'ATTACK_TREE' ? { attackTree: {
      rootGoal: 'Alter an approval status',
      tree: { goal: 'Alter an approval status', type: 'OR', children: [{
        goal: 'Submit an unverified callback status change', type: 'AND',
        children: [{ goal: 'Reach the callback endpoint without a verified relay signature', type: 'LEAF' }],
      }] },
    } } : {}),
  }
}

function draftIds(text: string): string[] {
  return [...new Set(text.match(/DRAFT-\d+/g) ?? [])]
}

function candidateIds(text: string): string[] {
  return [...new Set([
    ...[...text.matchAll(/"candidateId":"([^"]+)"/g)].map(match => match[1]!),
    ...(text.match(/CAND-\d+/g) ?? []),
    ...(text.match(/(?:STRIDE|PASTA|ATTACK_TREE)-\d+/g) ?? []),
  ])]
}

function responseFor(input: unknown): unknown {
  const text = JSON.stringify(input)
  calls.push(text)
  if (text.includes('ARCHITECTURE UNDERSTANDING')) return architecture()
  if (text.includes('finalizing a STRIDE threat model')) return { threats: [analystThreat('STRIDE')] }
  if (text.includes('finalizing a PASTA threat model')) return { threats: [analystThreat('PASTA')] }
  if (text.includes('finalizing attack trees')) return { threats: [analystThreat('ATTACK_TREE')] }
  if (text.includes('chief security architect finalizing')) {
    const ids = candidateIds(text)
    return { threats: [{
      sourceCandidateIds: ids.length ? ids : ['CAND-1'], disposition: 'conditional', preconditions: ['Verify the callback sender before accepting a status change.'],
      component: 'Review API', methodology: 'SYNTHESIS', description: longDescription,
      impact: 'Approval records could be changed incorrectly and require review before they are trusted.',
      mitigation: 'Verify relay callback signatures before accepting status changes and record verification failures.',
      controlReference: 'Callback signature verification', owaspCategories: ['A08:2021 – Software and Data Integrity Failures'],
      dread: { damage: 6, reproducibility: 4, exploitability: 4, affectedUsers: 5, discoverability: 4, total: 4.6 },
      priority: 'medium', confidenceScore: 0.82, evidenceSources: evidence,
    }] }
  }
  if (text.includes('security risk management specialist enriching')) {
    const ids = [...new Set(text.match(/THR-[a-f0-9-]+/g) ?? [])]
    return { validations: ids.map(id => ({
      id, title: 'Unauthenticated callback status update', description: longDescription,
      dread: { damage: 6, reproducibility: 4, exploitability: 4, affectedUsers: 5, discoverability: 4, total: 4.6 },
      correctionReason: 'The documented missing signature check leaves a conditional integrity concern.',
      traceability: { components: ['Review API'], endpoints: ['POST /callbacks/status'], securityConfigs: ['callback signature verification is not yet enabled'] },
    })) }
  }
  if (text.includes('red-team') || text.includes('Red Team') || text.includes('Red team')) {
    const ids = draftIds(text)
    const reply = text.includes("Reply to Blue's last turn")
    return { arguments: reply ? 'The transport control is accepted, while sender verification remains unresolved.' : 'The source supports a conditional callback-integrity finding.', convergenceSignal: true, threatAssessments: ids.map(draftId => ({ draftId, threatDescription: longDescription, applicability: 'conditional', severity: 'medium', notes: reply ? 'I accept the documented transport control, but it does not authenticate the callback sender.' : 'The callback signature control is documented as not yet enabled.' })) }
  }
  if (text.includes('blue-team') || text.includes('Blue Team') || text.includes('Blue team')) {
    const ids = draftIds(text)
    const reply = text.includes('Respond to Red\'s current reply')
    return { arguments: reply ? 'Blue accepts that transport alone does not establish callback authenticity.' : 'The documented transport control does not verify callback senders.', convergenceSignal: true, threatAssessments: ids.map(draftId => ({ draftId, threatDescription: longDescription, applicability: 'conditional', severity: 'medium', notes: reply ? 'I accept Red’s distinction: verify the relay sender before trusting callback status changes.' : 'Keep the finding conditional until the relay sender verification is confirmed.' })) }
  }
  if (text.includes('compact synthesis plan')) {
    const ids = candidateIds(text)
    return { candidates: Object.fromEntries(ids.map(id => [id, { decision: 'merge', mergeWith: ids.filter(other => other !== id), sourceIds: ['SRC-0002'], note: 'The same callback verification condition appears across analyst views.' }])), deduplication: 'Merge the three views of one callback integrity condition.', gaps: '', evidenceGap: '' }
  }
  // All evidence phases are real calls, but their prose is intentionally small
  // because the structured emissions above are what each agent validates.
  return 'The source states that callback signature verification is not yet enabled for the Review API. Preserve this as a conditional, architecture-anchored concern with SRC-0002.'
}

function installScriptedTransport(): void {
  scriptedInvoke.mockReset()
  scriptedInvoke.mockImplementation(async (input: unknown) => new AIMessageChunk({
    content: JSON.stringify(responseFor(input)), response_metadata: { finish_reason: 'stop' },
  }))
}

const originalRoot = process.env.AGENTICTM_WORKSPACE_ROOT
let testRoot: string | undefined

beforeEach(() => {
  calls.length = 0
  fetchGuard.mockReset()
  fetchGuard.mockImplementation(async () => {
    throw new Error('Unexpected network access in offline pipeline acceptance test')
  })
  installScriptedTransport()
})

afterEach(async () => {
  closeAllWorkspaceStorage()
  calls.length = 0
  clearConfigCache()
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
  if (originalRoot === undefined) delete process.env.AGENTICTM_WORKSPACE_ROOT
  else process.env.AGENTICTM_WORKSPACE_ROOT = originalRoot
})

function runConfig(): AnalysisConfig {
  return {
    provider: 'kimi', allowedProviders: ['kimi'], enabledAnalysts: ['stride', 'pasta', 'attack_tree'],
    executionMode: 'parallel', maxDebateRounds: 2, targetThreats: 3,
    requireEvidenceForHighPriority: true, useRag: false,
  }
}

async function createClaimedRun(id: string, config = runConfig()) {
  const manifest = createRunManifest({ inputFingerprint: 'a'.repeat(64), systemId: 'deskr', config, ragIndexFingerprint: 'b'.repeat(64) })
  await createThreatModel({ id, title: 'DeskRelay', input: sourceDocument, versionHash: 'c'.repeat(64), status: 'pending', metadata: { analysis_config: config, run_manifest: manifest } })
  setPipelineWorkerInstanceId('acceptance-worker')
  expect(await claimPipelineRun(id)).toBe(true)
}

describe('offline pipeline acceptance workflow', () => {
  it('runs parser, all required analysts, debate, synthesis and DREAD, then preserves validated findings in SQLite and exports', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-pipeline-acceptance-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    clearConfigCache()
    const project = await createLocalProject({ name: 'Offline acceptance' })

    await runWithWorkspace(project, async () => {
      await createClaimedRun('tm_acceptance_workflow')
      await executePipelineRun('tm_acceptance_workflow')

      const run = await getThreatModel('tm_acceptance_workflow')
      const storedThreats = await listThreats('tm_acceptance_workflow')
      const phases = await Promise.all(['architecture_parser', 'stride_analyst', 'pasta_analyst', 'attack_tree_analyst', 'pre_dedup', 'debate', 'threat_synthesizer', 'dread_validator'].map(phase => getRunArtifactText('tm_acceptance_workflow', `phase:${phase}`)))
      const finalThreats = JSON.parse((await getRunArtifactText('tm_acceptance_workflow', 'threats'))!) as Array<{
        id: string
        title: string
        scoringStatus?: string
        sourceCandidateIds?: string[]
        evidenceSources: Array<{ passageId?: string; citationId?: string; referenceStatus?: string; supportStatus?: string }>
        dread: { total: number }
      }>
      const report = await getRunArtifactText('tm_acceptance_workflow', 'report')
      const debateCheckpoint = JSON.parse((await getRunArtifactText('tm_acceptance_workflow', 'phase:debate'))!) as { rounds: Array<{
        round: number
        isFinalRound?: boolean
        threatAssessments: Array<{ redNotes?: string; blueNotes?: string }>
      }>; complete: boolean }
      const restored = mapRowToUnifiedThreat(storedThreats[0]!)
      const csv = generateCSV([restored])

      expect(run).toMatchObject({ status: 'completed', totalThreats: 1, methodologiesUsed: ['STRIDE', 'PASTA', 'ATTACK_TREE'] })
      expect(phases.every(Boolean)).toBe(true)
      expect(storedThreats).toHaveLength(1)
      expect(finalThreats).toHaveLength(1)
      expect(finalThreats[0]?.scoringStatus).toBe('validated')
      expect(finalThreats[0]?.dread.total).toBeCloseTo(4.6, 1)
      expect(finalThreats[0]?.sourceCandidateIds).toEqual(['STRIDE-01'])
      expect(finalThreats[0]?.evidenceSources[0]).toMatchObject({
        passageId: 'SRC-0002', citationId: 'SRC-0002', referenceStatus: 'verified', supportStatus: 'supports',
      })
      expect(storedThreats[0]?.dreadDamage).toBe(6)
      expect(storedThreats[0]?.id).toBeTruthy()
      expect((storedThreats[0]?.methodologyData as { sourceCandidateIds?: string[] } | null)?.sourceCandidateIds).toEqual(finalThreats[0]?.sourceCandidateIds)
      expect(storedThreats[0]?.evidenceSources).toEqual(finalThreats[0]?.evidenceSources)
      expect(storedThreats[0]?.id).not.toBe(finalThreats[0]?.id)
      expect(debateCheckpoint.complete).toBe(true)
      expect(debateCheckpoint.rounds).toHaveLength(2)
      expect(debateCheckpoint.rounds.map(round => round.isFinalRound)).toEqual([false, true])
      expect(debateCheckpoint.rounds.every(round => round.threatAssessments.every(item => item.redNotes && item.blueNotes))).toBe(true)
      expect(csv).toContain(storedThreats[0]!.id)
      expect(csv).toContain('Unauthenticated callback status update')
      expect(report).toContain('Unauthenticated callback status update')
      expect(calls.some(call => call.includes('ARCHITECTURE UNDERSTANDING'))).toBe(true)
      expect(calls.some(call => call.includes('finalizing a STRIDE threat model'))).toBe(true)
      expect(calls.some(call => call.includes('finalizing a PASTA threat model'))).toBe(true)
      expect(calls.some(call => call.includes('finalizing attack trees'))).toBe(true)
      expect(calls.some(call => call.includes('chief security architect finalizing'))).toBe(true)
      expect(calls.some(call => call.includes('security risk management specialist enriching'))).toBe(true)
      expect(fetchGuard).not.toHaveBeenCalled()
    })
  })

  it('fails after a required analyst error, retains earlier checkpoints, and never starts downstream stages', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-pipeline-required-analyst-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    clearConfigCache()
    const project = await createLocalProject({ name: 'Required analyst failure' })
    // The parser is first. Cause every subsequent STRIDE structured emission to
    // fail without replacing any agent or graph node.
    scriptedInvoke.mockImplementation(async (input: unknown) => {
      const text = JSON.stringify(input)
      if (text.includes('finalizing a STRIDE threat model')) throw new Error('offline stride transport failure')
      return new AIMessageChunk({ content: JSON.stringify(responseFor(input)), response_metadata: { finish_reason: 'stop' } })
    })

    await runWithWorkspace(project, async () => {
      await createClaimedRun('tm_required_analyst_failure')
      await executePipelineRun('tm_required_analyst_failure')
      const run = await getThreatModel('tm_required_analyst_failure')
      expect(run).toMatchObject({ status: 'failed' })
      expect(run?.errorMessage).toContain('StrideAnalyst')
      expect(await getRunArtifactText('tm_required_analyst_failure', 'phase:architecture_parser')).toBeTruthy()
      expect(await getRunArtifactText('tm_required_analyst_failure', 'phase:stride_analyst.degraded')).toBeTruthy()
      for (const phase of ['pre_dedup', 'debate', 'threat_synthesizer', 'dread_validator']) {
        expect(await getRunArtifactText('tm_required_analyst_failure', `phase:${phase}`)).toBeNull()
      }
      expect(fetchGuard).not.toHaveBeenCalled()
    })
  })
})
