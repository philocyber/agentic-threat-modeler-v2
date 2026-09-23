import { describe, expect, it } from 'vitest'
import {
  buildBluePrefetchQuery,
  buildDebateDossier,
  buildPreviousContext,
  buildRedPrefetchQuery,
  buildThreatsSummary,
} from '@/lib/agents/debate-dossier'
import type { ArchitectureData, DebateCandidate, DebateRound } from '@/lib/models/types'

const architecture = {
  systemDescription: 'Payments API behind Kong',
  components: [{ name: 'Kong Gateway', type: 'gateway', scope: 'edge', technology: 'Kong' }],
  dataFlows: [{ from: 'Client', to: 'Kong Gateway', data: 'HTTPS API', protocol: 'HTTPS' }],
  trustBoundaries: ['Internet / VPC'],
  externalEntities: ['Client'],
  dataStores: ['Postgres'],
  apiEndpoints: ['GET /api/users/:id'],
  deploymentInfo: 'EKS',
  mermaidDfd: '',
  techFlags: {
    hasAI: false,
    hasMicroservices: true,
    hasKubernetes: true,
    hasAuthSystem: true,
    hasExternalIntegrations: false,
    hasDatabaseLayer: true,
    hasFileStorage: false,
    hasMessageQueue: false,
  },
  factLedger: {
    sourceFacts: [
      { id: 'FACT-01', text: 'Kong validates JWTs on every route', category: 'control' as const },
    ],
    controls: [
      { id: 'CTRL-1', name: 'JWT validation', status: 'enabled' as const, component: 'Kong Gateway', evidence: 'Kong validates JWTs on every route' },
    ],
    assets: ['user PII'],
    assumptions: [],
  },
} as unknown as ArchitectureData

const longDescription = `The API endpoint GET /api/users/:id accepts unsigned JWTs and does not bind the path id to the token subject, which allows an attacker to read any tenant user record by swapping the identifier. ${'x'.repeat(200)}`

function candidate(partial: Partial<DebateCandidate> = {}): DebateCandidate {
  return {
    draftId: 'DRAFT-1',
    component: 'Kong Gateway',
    methodology: 'STRIDE',
    description: longDescription,
    impact: 'Account takeover across tenants',
    mitigation: 'Verify signatures and bind the path id to the token subject',
    confidenceScore: 0.9,
    evidenceSources: [
      { sourceType: 'architecture', sourceName: 'fact-ledger', excerpt: 'jwt validation is enabled on Kong' },
    ],
    reasoning: 'The route is internet-facing and the control is documented as enabled but unsigned tokens are still accepted.',
    traceability: { components: ['Kong Gateway'], endpoints: ['GET /api/users/:id'] },
    ...partial,
  }
}

describe('debate dossier', () => {
  it('includes the architecture summary and the full finding, not a 280-character stub', () => {
    const dossier = buildDebateDossier({
      architecture,
      threats: [candidate()],
      previousRounds: [],
    })

    expect(dossier).toContain('SYSTEM ARCHITECTURE:')
    expect(dossier).toContain('Payments API behind Kong')
    expect(dossier).toContain('Kong Gateway')
    expect(dossier).toContain('JWT validation')
    expect(dossier).toContain(longDescription)
    expect(dossier).toContain('Account takeover across tenants')
    expect(dossier).toContain('jwt validation is enabled on Kong')
    expect(dossier).toContain('GET /api/users/:id')
    expect(dossier).not.toContain(`${longDescription.slice(0, 280)}; impact=`)
  })

  it('keeps per-finding notes from prior rounds instead of a 300-character argument blob', () => {
    const previous: DebateRound[] = [{
      round: 1,
      redTeamArguments: 'x'.repeat(400),
      blueTeamArguments: 'y'.repeat(400),
      convergenceSignal: false,
      threatAssessments: [{
        draftId: 'DRAFT-1',
        threatDescription: longDescription,
        redVerdict: 'high',
        blueVerdict: 'medium',
        finalVerdict: 'medium',
        redNotes: 'Unsigned tokens still accepted on the users route',
        blueNotes: `CTRL-1 JWT validation is enabled on Kong. ${'Documented scope. '.repeat(60)}Only the public routes are covered; internal paths still need verification.`,
        judgeNotes: 'Residual risk is route coverage',
        notes: 'Judge: residual',
      }],
    }]

    const context = buildPreviousContext(previous)
    expect(context).toContain('DIALOGUE SO FAR')
    expect(context).toContain('DRAFT-1')
    expect(context).toContain('Unsigned tokens still accepted on the users route')
    expect(context).toContain('CTRL-1 JWT validation is enabled on Kong')
    expect(context).toContain('Residual risk is route coverage')
    expect(context).toContain('Only the public routes are covered; internal paths still need verification.')
    expect(context).not.toContain('red=high')
    expect(context).not.toContain('final=medium')
  })

  it('anchors RAG prefetch queries to the finding and documented controls', () => {
    const threats = [candidate()]
    expect(buildRedPrefetchQuery(threats)).toContain('Kong Gateway')
    expect(buildRedPrefetchQuery(threats)).toContain('unsigned JWTs')
    expect(buildBluePrefetchQuery(threats, architecture)).toContain('Kong Gateway')
    expect(buildBluePrefetchQuery(threats, architecture)).toContain('JWT validation:enabled')
    expect(buildThreatsSummary([candidate({ controlReference: 'NIST IA-2' })])).toContain(
      'controlReference=NIST IA-2',
    )
  })
})
