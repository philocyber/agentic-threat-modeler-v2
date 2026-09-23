import { describe, expect, it } from 'vitest'
import {
  buildRunQualityMetrics,
  checkRunQualityGates,
  compareRunQualityMetrics,
  formatRunQualityMetrics,
} from '@/lib/evaluation/run-metrics'
import { buildValidatorContext } from '@/lib/agents/dread-context'
import { emptyUsage } from '@/lib/llm/usage'
import type { ArchitectureData, DebateRound, UnifiedThreat } from '@/lib/models/types'

const architecture = {
  systemDescription: 'Payments platform',
  components: [
    { name: 'Kong Gateway', type: 'gateway', scope: 'dmz' },
    { name: 'Payments API', type: 'backend', scope: 'internal' },
  ],
  dataFlows: [],
  trustBoundaries: ['TB-1'],
  externalEntities: [],
  dataStores: ['Postgres'],
  apiEndpoints: [],
  deploymentInfo: '',
  mermaidDfd: '',
  techFlags: {
    hasAI: false, hasMicroservices: false, hasKubernetes: false, hasAuthSystem: true,
    hasExternalIntegrations: false, hasDatabaseLayer: true, hasFileStorage: false, hasMessageQueue: false,
  },
} as unknown as ArchitectureData

let counter = 0
function threat(partial: Partial<UnifiedThreat> = {}): UnifiedThreat {
  counter += 1
  const total = partial.dread?.total ?? 5
  return {
    id: `THR-${counter}`,
    component: 'Kong Gateway',
    strideCategory: 'Spoofing',
    methodology: 'STRIDE',
    description: `Distinct finding number ${counter} about a specific endpoint path`,
    impact: 'impact',
    mitigation: 'mitigation',
    dread: { damage: total, reproducibility: total, exploitability: total, affectedUsers: total, discoverability: total, total },
    priority: total >= 8 ? 'critical' : total >= 6.5 ? 'high' : total >= 4 ? 'medium' : 'low',
    confidenceScore: 0.8,
    evidenceSources: [{
      sourceType: 'architecture', sourceName: 'architecture', excerpt: 'Kong Gateway',
      referenceStatus: 'verified', supportStatus: 'supports',
    }],
    traceability: { components: ['Kong Gateway'] },
    ...partial,
  } as UnifiedThreat
}

describe('buildRunQualityMetrics', () => {
  it('reports the priority distribution and the inflation share', () => {
    const metrics = buildRunQualityMetrics({
      architecture,
      threats: [
        threat({ dread: { damage: 9, reproducibility: 9, exploitability: 9, affectedUsers: 9, discoverability: 9, total: 9 } }),
        threat({ dread: { damage: 9, reproducibility: 9, exploitability: 9, affectedUsers: 9, discoverability: 9, total: 8.5 } }),
        threat({ dread: { damage: 4, reproducibility: 4, exploitability: 4, affectedUsers: 4, discoverability: 4, total: 4 } }),
      ],
    })

    expect(metrics.priorityDistribution.critical).toBe(2)
    expect(metrics.priorityDistribution.medium).toBe(1)
    expect(metrics.highSeverityShare).toBeCloseTo(0.667, 2)
    expect(metrics.dread.spread).toBe(5)
    expect(metrics.dread.distinctTotals).toBe(3)
  })

  it('catches a collapsed ranking where every threat scores the same', () => {
    const metrics = buildRunQualityMetrics({
      architecture,
      threats: [threat(), threat(), threat()],
    })

    expect(metrics.dread.distinctTotals).toBe(1)
    expect(metrics.dread.spread).toBe(0)
    expect(checkRunQualityGates(metrics).map((v) => v.gate)).toContain('minDreadSpread')
  })

  it('measures STRIDE monoculture', () => {
    const metrics = buildRunQualityMetrics({
      architecture,
      threats: [
        threat({ strideCategory: 'Spoofing' }),
        threat({ strideCategory: 'Spoofing' }),
        threat({ strideCategory: 'Tampering' }),
        threat({ strideCategory: 'Denial of Service' }),
      ],
    })

    expect(metrics.stride.categoriesCovered).toBe(3)
    expect(metrics.stride.maxShare).toBe(0.5)
  })

  it('counts threats with no citation and no architecture anchor as unverifiable', () => {
    const metrics = buildRunQualityMetrics({
      architecture,
      threats: [
        threat(),
        threat({ evidenceSources: [], traceability: undefined }),
      ],
    })

    expect(metrics.evidence.withNeither).toBe(1)
    expect(metrics.evidence.verifiableShare).toBe(0.5)
    expect(checkRunQualityGates(metrics).map((v) => v.gate)).toContain('minVerifiableShare')
  })

  it('scores debate agreement and flags surviving invalid rulings', () => {
    const rounds: DebateRound[] = [{
      round: 1,
      redTeamArguments: '',
      blueTeamArguments: '',
      convergenceSignal: false,
      threatAssessments: [
        { draftId: 'DRAFT-1', threatDescription: 'a', redVerdict: 'high', blueVerdict: 'medium', finalVerdict: 'medium', notes: '' },
        { draftId: 'DRAFT-2', threatDescription: 'b', redVerdict: 'low', blueVerdict: 'low', finalVerdict: 'invalid', notes: '' },
      ],
    }]
    const validatorContext = buildValidatorContext({
      architecture,
      debateRounds: rounds,
      candidateIdByDraftId: new Map([['DRAFT-1', 'C1'], ['DRAFT-2', 'C2']]),
    })

    const agreeing = threat({
      sourceCandidateIds: ['C1'],
      dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5, total: 5 },
    })
    const invalidSurvivor = threat({ sourceCandidateIds: ['C2'] })

    const metrics = buildRunQualityMetrics({
      architecture,
      threats: [agreeing, invalidSurvivor],
      validatorContext,
    })

    expect(metrics.debate.assessed).toBe(2)
    expect(metrics.debate.agreeing).toBe(1)
    expect(metrics.debate.agreementShare).toBe(1)
    expect(metrics.debate.invalidHonoured).toBe(false)
    expect(checkRunQualityGates(metrics).map((v) => v.gate)).toContain('invalidHonoured')
  })

  it('surfaces per-agent degradation and token attribution', () => {
    const usage = emptyUsage()
    usage.inputTokens = 1_000
    usage.outputTokens = 500
    usage.byAgent = { StrideAnalyst: { inputTokens: 600, outputTokens: 300, calls: 2 } }
    usage.agentEvents = {
      DreadValidator: { bestEffortParses: 1, validationRetries: 2, transportRetries: 0 },
    }

    const metrics = buildRunQualityMetrics({ architecture, threats: [threat()], usage })

    expect(metrics.tokens.total).toBe(1_500)
    expect(metrics.tokens.byAgent.StrideAnalyst).toBe(900)
    expect(metrics.degradation.totals.bestEffortParses).toBe(1)
    expect(metrics.degradation.totals.validationRetries).toBe(2)
    expect(checkRunQualityGates(metrics).map((v) => v.gate)).toContain('maxBestEffortParses')
  })

  it('passes every gate for a healthy, well-ranked run', () => {
    const threats = [
      threat({ strideCategory: 'Spoofing', dread: { damage: 9, reproducibility: 9, exploitability: 9, affectedUsers: 9, discoverability: 9, total: 9 } }),
      threat({ strideCategory: 'Tampering', dread: { damage: 7, reproducibility: 7, exploitability: 7, affectedUsers: 7, discoverability: 7, total: 7 } }),
      threat({ strideCategory: 'Information Disclosure', dread: { damage: 6, reproducibility: 6, exploitability: 6, affectedUsers: 6, discoverability: 6, total: 6 } }),
      threat({ strideCategory: 'Denial of Service', dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5, total: 5 } }),
      threat({ strideCategory: 'Repudiation', dread: { damage: 4, reproducibility: 4, exploitability: 4, affectedUsers: 4, discoverability: 4, total: 4 } }),
      threat({ strideCategory: 'Elevation of Privilege', dread: { damage: 3, reproducibility: 3, exploitability: 3, affectedUsers: 3, discoverability: 3, total: 3 } }),
    ]

    const metrics = buildRunQualityMetrics({ architecture, threats })

    expect(checkRunQualityGates(metrics)).toEqual([])
    expect(formatRunQualityMetrics('fixture', metrics)).toContain('6/6 categories')
  })

  it('does not fail a well-cited short run for missing a minimum finding count', () => {
    const metrics = buildRunQualityMetrics({
      architecture,
      threats: [
        threat({ strideCategory: 'Spoofing', dread: { damage: 9, reproducibility: 9, exploitability: 9, affectedUsers: 9, discoverability: 9, total: 9 } }),
        threat({ strideCategory: 'Tampering', dread: { damage: 7, reproducibility: 7, exploitability: 7, affectedUsers: 7, discoverability: 7, total: 7 } }),
        threat({ strideCategory: 'Information Disclosure', dread: { damage: 4, reproducibility: 4, exploitability: 4, affectedUsers: 4, discoverability: 4, total: 4 } }),
      ],
    })
    expect(metrics.threatCount).toBe(3)
    expect(checkRunQualityGates(metrics).map((v) => v.gate)).not.toContain('minThreats')
  })
})

describe('compareRunQualityMetrics', () => {
  it('reports signed deltas against a baseline', () => {
    const before = buildRunQualityMetrics({
      architecture,
      threats: [threat({ dread: { damage: 9, reproducibility: 9, exploitability: 9, affectedUsers: 9, discoverability: 9, total: 9 } })],
    })
    const after = buildRunQualityMetrics({
      architecture,
      threats: [
        threat({ dread: { damage: 9, reproducibility: 9, exploitability: 9, affectedUsers: 9, discoverability: 9, total: 9 } }),
        threat({ dread: { damage: 4, reproducibility: 4, exploitability: 4, affectedUsers: 4, discoverability: 4, total: 4 } }),
      ],
    })

    const deltas = compareRunQualityMetrics(before, after)
    const byMetric = Object.fromEntries(deltas.map((d) => [d.metric, d]))

    expect(byMetric.threatCount?.delta).toBe(1)
    expect(byMetric.highSeverityShare?.delta).toBeLessThan(0)
    expect(byMetric.dreadSpread?.delta).toBe(5)
  })
})
