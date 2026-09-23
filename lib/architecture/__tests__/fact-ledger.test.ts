import { describe, expect, it } from 'vitest'
import { buildArchitectureFactLedger } from '../fact-ledger'
import type { ArchitectureData } from '@/lib/models/types'

const architecture: ArchitectureData = {
  systemDescription: 'Test',
  components: [{ name: 'API', type: 'service', scope: 'internal', technology: 'Node.js' }],
  dataFlows: [], trustBoundaries: [], externalEntities: [], dataStores: ['PostgreSQL'], apiEndpoints: [], deploymentInfo: '', mermaidDfd: '',
  techFlags: { hasAI: false, hasMicroservices: false, hasKubernetes: false, hasAuthSystem: true, hasExternalIntegrations: false, hasDatabaseLayer: true, hasFileStorage: false, hasMessageQueue: false },
}

describe('architecture fact ledger', () => {
  it('keeps recommendations and unevidenced controls unknown', () => {
    const ledger = buildArchitectureFactLedger('Rate limiting should be implemented. TLS encryption is not evidenced. Audit logging is planned.', architecture)
    expect(ledger.controls).toHaveLength(3)
    expect(ledger.controls.every(c => c.status === 'unknown')).toBe(true)
  })
  it('does not convert a parser boolean into absence when the source says unknown', () => {
    const ledger = buildArchitectureFactLedger('API controls remain unknown.', { ...architecture, detailedTopology: { securityConfigs: [{ component: 'API', configType: 'isolation', isEnabled: false, details: 'Memory isolation not documented.' }] } })
    expect(ledger.controls[0]?.status).toBe('unknown')
  })
  it('extracts explicit enabled controls without inventing missing controls', () => {
    const ledger = buildArchitectureFactLedger('The Node.js API uses parameterized queries. All traffic uses HTTPS. The database is in a private subnet.', architecture)
    expect(ledger.controls.map((control) => control.name)).toEqual(expect.arrayContaining(['Parameterized database queries', 'TLS transport encryption', 'Network isolation']))
    expect(ledger.controls.every((control) => control.status === 'enabled')).toBe(true)
  })

  it('does not treat an Internet-facing frontend as disabled backend isolation', () => {
    const ledger = buildArchitectureFactLedger(
      'The React SPA is Internet-facing. PostgreSQL and Redis are not Internet-facing and run in a private cluster.',
      architecture,
    )
    expect(ledger.controls.find((control) => control.name === 'Network isolation')?.status).toBe('enabled')
  })
})

describe('research-document regression', () => {
  it('never promotes HTTPS citations or markdown headings into controls or facts', () => {
    const ledger = buildArchitectureFactLedger('# Executive assessment\n[1](https://notion.so/source)[2](https://slack.com/thread)\nThe API processes orders.', architecture)
    expect(ledger.controls).toEqual([])
    expect(ledger.sourceFacts.map(f => f.text)).toEqual(['The API processes orders.'])
  })
  it('extracts controls from later source documents beyond the first forty fragments', () => {
    const source = Array.from({ length: 65 }, (_, i) => `Background observation number ${i}.`).join('\n') + '\n## Technical architecture\nThe API uses parameterized queries.'
    const ledger = buildArchitectureFactLedger(source, architecture)
    expect(ledger.controls.some(c => c.name === 'Parameterized database queries')).toBe(true)
    expect(ledger.sourceFacts.some(f => f.text.includes('parameterized'))).toBe(true)
  })
  it('keeps intended controls unknown even if a parser marks them enabled', () => {
    const ledger = buildArchitectureFactLedger('The API publishes reports.', { ...architecture, detailedTopology: { securityConfigs: [{ component: 'API', configType: 'identity', isEnabled: true, details: 'One authoritative page per run invariant intended.' }] } })
    expect(ledger.controls[0]?.status).toBe('unknown')
  })
})

it('does not infer TLS from a citation title either', () => {
  expect(buildArchitectureFactLedger('[TLS reference documentation](https://example.com/tls)', architecture).controls).toEqual([])
})

it('bounds large fact ledgers while scanning late controls', () => {
  const source = Array.from({ length: 400 }, (_, i) => `Background observation ${i} about service behavior.`).join('\n') + '\nThe API enforces JWT validation.'
  const ledger = buildArchitectureFactLedger(source, architecture)
  expect(ledger.sourceFacts.length).toBeLessThanOrEqual(160)
  expect(ledger.controls.some(c => c.name === 'JWT validation')).toBe(true)
  expect(ledger.sourceFacts.some(f => Number(f.id.slice(5)) > 350)).toBe(true)
  expect(ledger.assumptions.join(' ')).toContain('sampled across the full input')
})
