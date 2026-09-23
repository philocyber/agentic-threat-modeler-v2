import { describe, expect, it } from 'vitest'
import {
  buildValidatorContext,
  formatControlsBlock,
  formatValidatorThreat,
  verdictForThreat,
} from '@/lib/agents/dread-context'
import type { ArchitectureData, DebateRound, UnifiedThreat } from '@/lib/models/types'

const architecture = {
  systemDescription: 'Payments API behind Kong',
  components: [],
  dataFlows: [],
  trustBoundaries: [],
  externalEntities: [],
  dataStores: [],
  apiEndpoints: [],
  deploymentInfo: '',
  mermaidDfd: '',
  techFlags: {
    hasAI: false,
    hasMicroservices: false,
    hasKubernetes: false,
    hasAuthSystem: true,
    hasExternalIntegrations: false,
    hasDatabaseLayer: true,
    hasFileStorage: false,
    hasMessageQueue: false,
  },
  factLedger: {
    sourceFacts: [],
    controls: [
      { id: 'CTRL-1', name: 'JWT validation', status: 'enabled' as const, component: 'Kong', evidence: 'Kong validates JWTs on every route' },
      { id: 'CTRL-2', name: 'Rate limiting', status: 'disabled' as const, evidence: 'no rate limiting configured' },
      { id: 'CTRL-3', name: 'Audit logging', status: 'unknown' as const, evidence: 'not mentioned' },
    ],
    assets: [],
    assumptions: [],
  },
} as unknown as ArchitectureData

function threat(partial: Partial<UnifiedThreat> = {}): UnifiedThreat {
  return {
    id: 'THR-1',
    component: 'Kong Gateway',
    methodology: 'STRIDE',
    description: 'Unsigned tokens accepted on GET /api/users/:id, allowing impersonation of any tenant user.',
    impact: 'Account takeover',
    mitigation: 'Verify signatures',
    dread: { damage: 9, reproducibility: 10, exploitability: 10, affectedUsers: 10, discoverability: 9, total: 9.6 },
    priority: 'critical',
    confidenceScore: 0.9,
    evidenceSources: [],
    sourceCandidateIds: ['STRIDE-01'],
    ...partial,
  } as UnifiedThreat
}

const rounds: DebateRound[] = [
  {
    round: 1,
    redTeamArguments: 'red',
    blueTeamArguments: 'blue',
    convergenceSignal: false,
    threatAssessments: [
      {
        draftId: 'DRAFT-1',
        threatDescription: 'Unsigned tokens accepted',
        redVerdict: 'critical',
        blueVerdict: 'medium',
        finalVerdict: 'medium',
        disposition: 'control_verification_needed',
        notes: 'JWT validation is enabled; residual risk is route coverage',
        blueNotes: 'Kong jwt plugin enabled on all routes',
        judgeNotes: 'Documented control applies; medium residual',
      },
    ],
  },
]

describe('buildValidatorContext', () => {
  it('splits ledger controls by status', () => {
    const context = buildValidatorContext({ architecture })

    expect(context.enabledControls.map((c) => c.name)).toEqual(['JWT validation'])
    expect(context.disabledControls.map((c) => c.name)).toEqual(['Rate limiting'])
  })

  it('joins debate rulings to candidate ids through the draft mapping', () => {
    const context = buildValidatorContext({
      architecture,
      debateRounds: rounds,
      candidateIdByDraftId: new Map([['DRAFT-1', 'STRIDE-01']]),
    })

    const verdict = verdictForThreat(threat(), context)
    expect(verdict?.finalVerdict).toBe('medium')
    expect(verdict?.disposition).toBe('control_verification_needed')
    expect(verdict?.judgeNotes).toContain('medium residual')
  })

  it('drops rulings whose draft id has no candidate mapping', () => {
    const context = buildValidatorContext({ architecture, debateRounds: rounds })
    expect(context.verdictByCandidateId.size).toBe(0)
    expect(verdictForThreat(threat(), context)).toBeUndefined()
  })

  it('later rounds supersede earlier rulings for the same draft', () => {
    const secondRound: DebateRound = {
      ...rounds[0]!,
      round: 2,
      threatAssessments: [{ ...rounds[0]!.threatAssessments[0]!, finalVerdict: 'low' }],
    }
    const context = buildValidatorContext({
      architecture,
      debateRounds: [rounds[0]!, secondRound],
      candidateIdByDraftId: new Map([['DRAFT-1', 'STRIDE-01']]),
    })

    expect(verdictForThreat(threat(), context)?.finalVerdict).toBe('low')
  })
})

describe('formatControlsBlock', () => {
  it('lists enabled and disabled controls with their evidence', () => {
    const block = formatControlsBlock(buildValidatorContext({ architecture }))

    expect(block).toContain('[enabled] JWT validation @ Kong')
    expect(block).toContain('[disabled/missing] Rate limiting')
    expect(block).toContain('UNKNOWN coverage')
    expect(block).toContain('[unknown] Audit logging')
    expect(block).not.toContain('assumed NOT to exist')
  })

  it('says so explicitly when no controls were extracted', () => {
    const block = formatControlsBlock(buildValidatorContext({}))
    expect(block).toContain('none were extracted')
  })
})

describe('formatValidatorThreat', () => {
  const context = buildValidatorContext({
    architecture,
    debateRounds: rounds,
    candidateIdByDraftId: new Map([['DRAFT-1', 'STRIDE-01']]),
  })

  it('keeps the full description, not a 250-char stub', () => {
    const long = 'x'.repeat(400) + ' GET /api/payments/:id'
    const entry = formatValidatorThreat(threat({ description: long }), context)

    expect(entry).toContain('GET /api/payments/:id')
  })

  it('shows the debate ruling so the prompt has a band to respect', () => {
    const entry = formatValidatorThreat(threat(), context)

    expect(entry).toContain('DEBATE (DRAFT-1): final=medium')
    expect(entry).toContain('disposition=control_verification_needed')
    expect(entry).toContain('DREAD proposed by synthesis: D=9')
  })

  it('omits the debate line for threats that were never debated', () => {
    const entry = formatValidatorThreat(threat({ sourceCandidateIds: ['PASTA-09'] }), context)
    expect(entry).not.toContain('DEBATE (')
  })
})
