import { describe, expect, it } from 'vitest'
import type { ArchitectureData, UnifiedThreat } from '@/lib/models/types'
import { applyControlAwareValidation } from '../control-awareness'

function architecture(component?: string): ArchitectureData {
  return {
    systemDescription: 'API', components: [], dataFlows: [], trustBoundaries: [],
    externalEntities: [], dataStores: [], apiEndpoints: [], deploymentInfo: '', mermaidDfd: '',
    techFlags: {
      hasAI: false, hasMicroservices: false, hasKubernetes: false, hasAuthSystem: true,
      hasExternalIntegrations: false, hasDatabaseLayer: false, hasFileStorage: false, hasMessageQueue: false,
    },
    factLedger: {
      sourceFacts: [], assets: [], assumptions: [],
      controls: [{ id: 'CTRL-JWT', name: 'JWT validation', status: 'enabled', evidence: 'enabled', ...(component ? { component } : {}) }],
    },
  }
}

function threat(): UnifiedThreat {
  return {
    id: 'THR-1', component: 'Orders API', methodology: 'STRIDE',
    description: 'JWT authentication bypass permits account takeover', impact: 'impact', mitigation: 'mitigation',
    dread: { damage: 9, reproducibility: 9, exploitability: 9, affectedUsers: 9, discoverability: 9, total: 9 },
    priority: 'critical', confidenceScore: 0.9, evidenceSources: [],
    traceability: { components: ['Orders API'], endpoints: ['GET /orders/:id'] },
  }
}

describe('control-aware validation', () => {
  it('does not reduce DREAD for a global control with undocumented coverage', () => {
    const [result] = applyControlAwareValidation([threat()], architecture(), 10)
    expect(result?.dread.total).toBe(9)
    expect(result?.disposition).toBe('control_verification_needed')
  })

  it('reduces only when the enabled control matches the threat component', () => {
    const [result] = applyControlAwareValidation([threat()], architecture('Orders API'), 10)
    expect(result?.dread.total).toBeLessThan(9)
    expect(result?.controlReference).toBe('CTRL-JWT')
  })
})
