import { describe, expect, it } from 'vitest'
import {
  ARCHITECTURE_DIAGRAM_MAX_FLOWS,
  ARCHITECTURE_DIAGRAM_MAX_NODES,
  buildArchitectureMermaid,
  buildArchitectureReferences,
} from '../mermaid'

describe('buildArchitectureMermaid', () => {
  it('builds deterministic syntax from structured architecture data', () => {
    const chart = buildArchitectureMermaid({
      externalEntities: ['Customer [browser]'],
      dataStores: ['Redis Cache'],
      trustBoundaries: ['Internet to internal'],
      components: [
        { name: 'REST API (Next.js)', type: 'service', scope: 'internal' },
        { name: 'Redis Cache', type: 'data store', scope: 'internal' },
      ],
      dataFlows: [
        { from: 'Customer [browser]', to: 'REST API (Next.js)', data: 'JWT / request', protocol: 'HTTPS' },
        { from: 'REST API (Next.js)', to: 'Redis Cache', data: 'session {record}', protocol: 'TLS' },
      ],
    })

    expect(chart).toContain('flowchart TB')
    expect(chart).toContain('%%{init: {"htmlLabels": false')
    expect(chart).toContain('subgraph ZONE_EXTERNAL["EXTERNAL"]')
    expect(chart).toContain('subgraph ZONE_INTERNAL["INTERNAL"]')
    expect(chart).toContain('N1 -->|"HTTPS / JWT / request"| N2')
    expect(chart).toContain('"curve": "stepAfter"')
    expect(chart).toContain('stroke-dasharray:8 6')
    expect(chart).toContain('linkStyle default stroke:#6F686C')
    expect(chart).not.toContain('[browser]')
    expect(chart).not.toContain('{record}')
    expect(chart).not.toMatch(/[💣🤖]/u)
  })

  it('keeps every descriptive control linked to its threat when the source ID is opaque', () => {
    const references = buildArchitectureReferences({
      externalEntities: [],
      dataStores: ['PostgreSQL'],
      trustBoundaries: [],
      components: [{ name: 'PostgreSQL', type: 'data store', scope: 'internal' }],
      dataFlows: [],
    }, [{
      id: 'uuid-1',
      displayId: 'IAM-01',
      title: 'Plaintext database credentials',
      component: 'PostgreSQL',
      controlReference: 'CTRL-01',
      mitigation: 'Store credentials in a managed vault and rotate them automatically.',
    }])

    expect(references).toContainEqual(expect.objectContaining({
      id: 'C01',
      kind: 'control',
      linkedThreatId: 'IAM-01',
      sourceControlId: 'CTRL-01',
      label: 'Store credentials in a managed vault and rotate them automatically.',
    }))
  })

  it('bounds large diagrams while keeping finding-linked components', () => {
    const components = Array.from({ length: 80 }, (_, index) => ({
      name: `Component ${index}`,
      type: 'service',
      scope: 'internal',
    }))
    const dataFlows = Array.from({ length: 79 }, (_, index) => ({
      from: `Component ${index}`,
      to: `Component ${index + 1}`,
      data: `payload ${index}`,
      protocol: 'HTTPS',
    }))
    const chart = buildArchitectureMermaid({
      externalEntities: [],
      dataStores: [],
      trustBoundaries: [],
      components,
      dataFlows,
    }, [{ id: 'T-01', component: 'Component 79' }])

    expect(chart).toContain('Component 79')
    expect((chart.match(/^\s+N\d+\[/gm) ?? []).length).toBeLessThanOrEqual(ARCHITECTURE_DIAGRAM_MAX_NODES)
    expect((chart.match(/-->/g) ?? []).length).toBeLessThanOrEqual(ARCHITECTURE_DIAGRAM_MAX_FLOWS)
  })
})

describe('diagram scope and identity regression', () => {
  it('keeps the central store and does not collapse provider names by substring', () => {
    const chart = buildArchitectureMermaid({ components: [
      { name: 'Service A', type: 'service', scope: 'external' },
      { name: 'Service A/Service B', type: 'service', scope: 'external' },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `Unconnected ${i}`, type: 'service', scope: 'internal' })),
      { name: 'Store', type: 'data store', scope: 'internal' },
    ], externalEntities: [], dataStores: ['Store'], trustBoundaries: [], dataFlows: [
      { from: 'Service A', to: 'Store', data: 'artifacts' }, { from: 'Service A/Service B', to: 'Store', data: 'evidence' },
    ] })
    expect(chart).toContain('Service A/Service B')
    expect(chart).toContain('Store')
    expect(chart).toContain('additional nodes')
  })
  it('does not diagram proposed integrations as current edges', () => {
    const chart = buildArchitectureMermaid({ components: [
      { name: 'Target', type: 'service', scope: 'internal' }, { name: 'Adjacent Bot', type: 'service', scope: 'internal', relationship: 'proposed' },
    ], externalEntities: [], dataStores: [], trustBoundaries: [], dataFlows: [{ from: 'Adjacent Bot', to: 'Target', data: 'future integration' }] })
    expect(chart).not.toContain('Adjacent Bot')
    expect(chart).not.toContain('future integration')
  })
})

it('preserves external trust zones when findings prioritize a component', () => {
  const chart = buildArchitectureMermaid({ components: [{ name: 'Notion', type: 'external', scope: 'external' }, { name: 'Store', type: 'service', scope: 'internal' }], dataFlows: [{ from: 'Store', to: 'Notion', data: 'publication' }], externalEntities: [], dataStores: ['Store'], trustBoundaries: [] }, [{ id: 'T1', component: 'Notion', traceability: { components: ['Notion invented pipeline'] } }])
  expect(chart).toContain('subgraph ZONE_EXTERNAL')
  expect(chart).not.toContain('Notion invented pipeline')
})
