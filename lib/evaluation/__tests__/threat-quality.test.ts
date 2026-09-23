import { describe, expect, it } from 'vitest'
import { evaluateThreatQuality } from '../threat-quality'
import type { ArchitectureData, UnifiedThreat } from '@/lib/models/types'

const architecture: ArchitectureData = {
  systemDescription: 'Banking platform',
  components: [{ name: 'Gateway', type: 'gateway', scope: 'dmz' }, { name: 'Backend', type: 'service', scope: 'internal' }],
  dataFlows: [], trustBoundaries: [], externalEntities: [], dataStores: [], apiEndpoints: [], deploymentInfo: '', mermaidDfd: '',
  techFlags: { hasAI: false, hasMicroservices: true, hasKubernetes: true, hasAuthSystem: true, hasExternalIntegrations: true, hasDatabaseLayer: true, hasFileStorage: false, hasMessageQueue: false },
  factLedger: { sourceFacts: [], controls: [{ id: 'CTRL-01', name: 'Parameterized database queries', status: 'enabled', evidence: 'uses parameterized queries' }], assets: [], assumptions: [] },
}

function threat(id: string, component: string, title: string, disposition: UnifiedThreat['disposition'] = 'applicable'): UnifiedThreat {
  return {
    id, component, title, methodology: 'STRIDE', methodologies: ['STRIDE'],
    description: `${title} permits an attacker to affect the system through an architecture-specific path.`,
    impact: 'Impact', mitigation: 'Mitigation',
    dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5, total: 5 },
    priority: 'medium', confidenceScore: 0.8,
    evidenceSources: [{
      sourceType: 'architecture', sourceName: 'SRC-0001', excerpt: `${component} is in scope.`,
      referenceStatus: 'verified', supportStatus: 'supports',
    }],
    disposition,
  }
}

describe('threat quality evaluation', () => {
  it('rejects a zero placeholder mislabeled as validated', () => {
    const item = { ...threat('placeholder', 'Gateway', 'Unresolved access control'), scoringStatus: 'validated' as const,
      dread: { damage: 0, reproducibility: 0, exploitability: 0, affectedUsers: 0, discoverability: 0, total: 0 } }
    const report = evaluateThreatQuality(architecture, [item])
    expect(report.unscoredFindingIds).toEqual(['placeholder'])
    expect(report.passed).toBe(false)
  })
  it('detects semantic duplicates and explicit-control contradictions', () => {
    const report = evaluateThreatQuality(architecture, [
      threat('1', 'Gateway', 'JWT validation bypass'),
      threat('2', 'Gateway', 'JWT validation bypass recurring'),
      threat('3', 'Backend', 'SQL injection due to unparameterized queries'),
    ])
    expect(report.duplicatePairs.length).toBeGreaterThan(0)
    expect(report.possibleControlContradictions).toContain('3')
  })

  it('accepts a control-aware residual finding', () => {
    const report = evaluateThreatQuality(architecture, [
      threat('1', 'Backend', 'SQL injection through parameterization bypass', 'control_verification_needed'),
    ])
    expect(report.possibleControlContradictions).toEqual([])
  })

  it('does not treat finding count as a quality pass', () => {
    const report = evaluateThreatQuality(architecture, [
      threat('1', 'Gateway', 'Session fixation at the edge'),
      threat('2', 'Backend', 'Stored cross-site scripting in reports'),
    ])
    expect(report.threatCount).toBe(2)
    expect(report.passed).toBe(true)
  })

  it('fails when a quotation is unverified or unlinked, regardless of volume', () => {
    const unverified = {
      ...threat('1', 'Gateway', 'Forged tokens at the edge'),
      evidenceSources: [{
        sourceType: 'rag' as const, sourceName: 'RAG-deadbeefdeadbeefdeadbeef', excerpt: 'Tokens are unrestricted.',
        referenceStatus: 'unverified' as const, supportStatus: 'unlinked' as const,
      }],
    }
    const unlinked = {
      ...threat('2', 'Backend', 'Queue injection'),
      evidenceSources: [{
        sourceType: 'architecture' as const, sourceName: 'SRC-0002', excerpt: 'ExportWorker runs in a private subnet.',
        referenceStatus: 'verified' as const, supportStatus: 'unlinked' as const,
      }],
    }
    expect(evaluateThreatQuality(architecture, [unverified, threat('ok', 'Backend', 'Distinct backend finding')]).passed).toBe(false)
    expect(evaluateThreatQuality(architecture, [unlinked, threat('ok', 'Gateway', 'Distinct gateway finding')]).passed).toBe(false)
    expect(evaluateThreatQuality(architecture, [unverified]).evidenceIntegrity.ragReferences).toMatchObject({ unverified: 1, unlinked: 1 })
    expect(evaluateThreatQuality(architecture, [unlinked]).evidenceIntegrity.architectureAnchors).toMatchObject({ verified: 1, unlinked: 1 })
  })

  it('passes a finding with verified support even when an auxiliary passage is unlinked', () => {
    const supported = threat('supported', 'Gateway', 'Scoped token confusion')
    supported.evidenceSources.push({
      sourceType: 'rag', sourceName: 'RAG-012345678901234567890123', excerpt: 'Generic background.',
      referenceStatus: 'verified', supportStatus: 'unlinked',
    })
    const report = evaluateThreatQuality(architecture, [
      supported,
      threat('backend', 'Backend', 'Stored script execution in reports'),
    ])
    expect(report.evidenceIntegrity.ragReferences.unlinked).toBe(1)
    expect(report.evidenceIntegrity.unlinkedFindingIds).toEqual([])
    expect(report.passed).toBe(true)
  })
})
