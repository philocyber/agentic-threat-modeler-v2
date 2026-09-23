import { isInScope } from './scope'
import type { ArchitectureData } from '@/lib/models/types'

type DiagramArchitecture = Pick<
  ArchitectureData,
  'components' | 'dataFlows' | 'externalEntities' | 'dataStores' | 'trustBoundaries'
>

export type DiagramThreat = {
  id: string
  displayId?: string | undefined
  title?: string | undefined
  component?: string | null | undefined
  mitigation?: string | null | undefined
  controlReference?: string | null | undefined
  traceability?: { components?: string[] | undefined } | null | undefined
}

export type ArchitectureReference = {
  id: string
  label: string
  kind: 'threat' | 'control'
  component: string
  linkedThreatId?: string | undefined
  linkedThreatLabel?: string | undefined
  sourceControlId?: string | undefined
}

type DiagramNode = {
  id: string
  name: string
  type: string
  scope: string
  technology: string
  kind: 'actor' | 'service' | 'gateway' | 'store' | 'queue' | 'external'
  threats: string[]
  controls: string[]
}

export const ARCHITECTURE_DIAGRAM_MAX_NODES = 16
export const ARCHITECTURE_DIAGRAM_MAX_FLOWS = 12

function cleanLabel(value: string | null | undefined, max = 72): string {
  return (value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\[\]{}<>|"`]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function key(value: string): string {
  return cleanLabel(value)
    .toLowerCase()
    .replace(/\((external|public|internal)\)/g, '')
    .replace(/\b(service|data store)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function wrapFlowLabel(value: string, lineLength = 30): string {
  const words = value.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current && `${current} ${word}`.length > lineLength) {
      lines.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, 2).join('<br/>')
}

function nodeKind(name: string, type: string, dataStores: string[]): DiagramNode['kind'] {
  const value = `${name} ${type}`.toLowerCase()
  if (dataStores.some((store) => key(store) === key(name)) || /(database|data store|postgres|mysql|redis|cache|bucket|storage)/.test(value)) return 'store'
  if (/(queue|broker|kafka|rabbit|sqs|event bus)/.test(value)) return 'queue'
  if (/(gateway|proxy|load balancer|firewall|waf)/.test(value)) return 'gateway'
  if (/(user|actor|browser|client)/.test(value)) return 'actor'
  if (/(external|third party|provider)/.test(value)) return 'external'
  return 'service'
}

function zoneKey(scope: string, kind: DiagramNode['kind']): string {
  const value = scope.toLowerCase()
  if (kind === 'external' || value.includes('external') || value.includes('cloud')) return 'external'
  if (value.includes('public') || value.includes('untrusted')) return 'public'
  if (value.includes('dmz') || value.includes('edge')) return 'dmz'
  return 'internal'
}

function compactReferences(values: string[], limit = 3): string[] {
  if (values.length <= limit) return values
  return [...values.slice(0, limit), `+${values.length - limit}`]
}

function nodeDefinition(node: DiagramNode): string {
  const threatLine = node.threats.length ? `T  ${node.threats.join('  ')}` : ''
  // Keep the canvas scannable. Type and technology remain in the component
  // table; the diagram carries only identity plus its security traceability.
  const label = [node.name, threatLine].filter(Boolean).join('<br/>')
  if (node.kind === 'store') return `${node.id}[("${label}")]`
  if (node.kind === 'queue') return `${node.id}[["${label}"]]`
  if (node.kind === 'actor' || node.kind === 'external') return `${node.id}(["${label}"])`
  return `${node.id}["${label}"]`
}

function matchesComponent(threat: DiagramThreat, nodeName: string): boolean {
  const target = key(nodeName)
  const candidates = [threat.component, ...(threat.traceability?.components ?? [])]
    .filter((value): value is string => Boolean(value))
    .map(key)
  return candidates.some((candidate) => candidate === target || candidate.includes(target) || target.includes(candidate))
}

export function buildArchitectureReferences(
  architecture: DiagramArchitecture,
  threats: DiagramThreat[] = [],
): ArchitectureReference[] {
  const references: ArchitectureReference[] = []
  let controlIndex = 0
  for (const threat of threats) {
    const component = threat.component ?? threat.traceability?.components?.[0] ?? 'Architecture'
    const threatId = threat.displayId ?? threat.id
    const threatLabel = threat.title ?? 'Threat finding'
    references.push({
      id: threatId,
      label: threatLabel,
      kind: 'threat',
      component,
    })
    const sourceControlId = /^CTRL-[A-Z0-9-]+$/i.test(threat.controlReference?.trim() ?? '')
      ? threat.controlReference?.trim()
      : undefined
    const control = sourceControlId
      ? threat.mitigation || sourceControlId
      : threat.controlReference || threat.mitigation
    if (control) {
      controlIndex += 1
      references.push({
        id: `C${String(controlIndex).padStart(2, '0')}`,
        label: cleanLabel(control, 180),
        kind: 'control',
        component,
        linkedThreatId: threatId,
        linkedThreatLabel: threatLabel,
        sourceControlId,
      })
    }
  }
  return references
}

export function buildArchitectureMermaid(
  architecture: DiagramArchitecture,
  threats: DiagramThreat[] = [],
): string {
  const excluded = new Set(architecture.components.filter(c => !isInScope(c)).map(c => key(c.name)))
  architecture = { ...architecture, components: architecture.components.filter(isInScope), dataFlows: architecture.dataFlows.filter(f => !excluded.has(key(f.from)) && !excluded.has(key(f.to))), externalEntities: architecture.externalEntities.filter(n => !excluded.has(key(n))) }
  const nodes = new Map<string, DiagramNode>()
  const references = buildArchitectureReferences(architecture, threats)
  const knownNames = [...architecture.components.map(c => c.name), ...architecture.externalEntities, ...architecture.dataFlows.flatMap(f => [f.from, f.to])]
  const knownKeys = new Set(knownNames.map(key))
  const priorityNames = threats.flatMap((threat) => [
    threat.component,
    ...(threat.traceability?.components ?? []),
  ]).filter((name): name is string => Boolean(name) && knownKeys.has(key(name!)))
  const degree = (name: string) => architecture.dataFlows.filter(f => key(f.from) === key(name) || key(f.to) === key(name)).length
  const rankedComponents = architecture.components.slice().sort((a, b) => degree(b.name) - degree(a.name))
  const candidateNames = [
    ...priorityNames,
    ...rankedComponents.map((component) => component.name),
    ...architecture.externalEntities,
    ...architecture.dataFlows.flatMap((flow) => [flow.from, flow.to]),
  ]
  const selectedKeys = new Set<string>()
  for (const name of candidateNames) {
    const normalized = key(name)
    if (!normalized || selectedKeys.has(normalized)) continue
    selectedKeys.add(normalized)
    if (selectedKeys.size >= ARCHITECTURE_DIAGRAM_MAX_NODES) break
  }
  const selected = (name: string) => selectedKeys.has(key(name))

  const ensureNode = (name: string, type = 'service', scope = 'internal', technology = '') => {
    const normalized = key(name)
    const existing = nodes.get(normalized)
    if (existing) return existing.id
    const id = `N${nodes.size + 1}`
    const safeName = cleanLabel(name) || `Component ${nodes.size + 1}`
    const kind = nodeKind(safeName, type, architecture.dataStores ?? [])
    const nodeThreats = threats.filter((threat) => matchesComponent(threat, safeName))
    const threatIds = compactReferences(nodeThreats.map((threat) => threat.displayId ?? threat.id))
    const controlIds = compactReferences(references
      .filter((reference) => reference.kind === 'control' && nodeThreats.some((threat) => matchesComponent(threat, reference.component)))
      .map((reference) => reference.id)
    )
    nodes.set(normalized, {
      id,
      name: safeName,
      type: cleanLabel(type, 20),
      scope: cleanLabel(scope, 24),
      technology: cleanLabel(technology, 24),
      kind,
      threats: threatIds,
      controls: controlIds,
    })
    return id
  }

  priorityNames.filter(selected).forEach((name) => {
    const component = architecture.components.find(c => key(c.name) === key(name))
    const external = architecture.externalEntities.some(n => key(n) === key(name))
    ensureNode(name, component?.type ?? (external ? 'external entity' : 'service'), component?.scope ?? (external ? 'external' : 'internal'), component?.technology)
  })
  architecture.externalEntities.filter(selected).forEach((entity) => ensureNode(entity, 'external entity', 'external'))
  architecture.components.filter((component) => selected(component.name)).forEach((component) => ensureNode(component.name, component.type, component.scope, component.technology))
  const visibleFlows = architecture.dataFlows
    .filter((flow) => selected(flow.from) && selected(flow.to))
    .sort((a, b) => {
      const boundary = (f: typeof a) => architecture.components.find(c => key(c.name) === key(f.from))?.scope !== architecture.components.find(c => key(c.name) === key(f.to))?.scope
      return Number(boundary(b)) - Number(boundary(a))
    })
    .slice(0, ARCHITECTURE_DIAGRAM_MAX_FLOWS)
  visibleFlows.forEach((flow) => {
    ensureNode(flow.from)
    ensureNode(flow.to)
  })

  const zones = [
    { key: 'external', id: 'ZONE_EXTERNAL', label: 'EXTERNAL' },
    { key: 'public', id: 'ZONE_PUBLIC', label: 'UNTRUSTED' },
    { key: 'dmz', id: 'ZONE_DMZ', label: 'DMZ / EDGE' },
    { key: 'internal', id: 'ZONE_INTERNAL', label: 'INTERNAL' },
  ]
  const lines = [
    '%%{init: {"htmlLabels": false, "flowchart": {"curve": "stepAfter", "nodeSpacing": 54, "rankSpacing": 78}}}%%',
    'flowchart TB',
  ]

  for (const zone of zones) {
    const zoneNodes = [...nodes.values()].filter((node) => zoneKey(node.scope, node.kind) === zone.key)
    if (!zoneNodes.length) continue
    lines.push(`  subgraph ${zone.id}["${zone.label}"]`)
    lines.push('    direction TB')
    zoneNodes.forEach((node) => lines.push(`    ${nodeDefinition(node)}`))
    lines.push('  end')
  }

  const resolveNode = (name: string) => {
    const normalized = key(name)
    return nodes.get(normalized)
  }
  visibleFlows.forEach((flow) => {
    const from = resolveNode(flow.from)?.id
    const to = resolveNode(flow.to)?.id
    if (!from || !to) return
    const protocol = cleanLabel(flow.protocol, 18)
    const data = cleanLabel(flow.data, 58)
    const includesProtocol = protocol && data.toLowerCase().startsWith(protocol.toLowerCase())
    const label = wrapFlowLabel([includesProtocol ? '' : protocol, data].filter(Boolean).join(' / '))
    lines.push(label ? `  ${from} -->|"${label}"| ${to}` : `  ${from} --> ${to}`)
  })

  const omittedNodes = new Set(candidateNames.map(key).filter(Boolean)).size - nodes.size
  const omittedFlows = architecture.dataFlows.length - visibleFlows.length
  if (omittedNodes > 0 || omittedFlows > 0) lines.push(`  OMITTED["Overview: ${Math.max(0, omittedNodes)} additional nodes and ${omittedFlows} flows omitted"]`)

  // ThreatCanvas-inspired hierarchy: quiet component surfaces, recognizable
  // DFD shapes and high-contrast text. Strong brand colors stay reserved for
  // the T/C references rather than flooding every node.
  lines.push('  classDef actor fill:#FFF8E8,stroke:#E3A000,color:#2C282B,stroke-width:1.5px')
  lines.push('  classDef service fill:#F4F1ED,stroke:#6F686C,color:#2C282B,stroke-width:1.5px')
  lines.push('  classDef gateway fill:#FFFFFF,stroke:#F96715,color:#2C282B,stroke-width:1.5px')
  lines.push('  classDef store fill:#FFFFFF,stroke:#218848,color:#2C282B,stroke-width:1.5px')
  lines.push('  classDef queue fill:#FFFFFF,stroke:#475CC7,color:#2C282B,stroke-width:1.5px')
  lines.push('  classDef external fill:#FFF8E8,stroke:#E3A000,color:#2C282B,stroke-width:1.5px')
  for (const kind of ['actor', 'service', 'gateway', 'store', 'queue', 'external'] as const) {
    const ids = [...nodes.values()].filter((node) => node.kind === kind).map((node) => node.id)
    if (ids.length) lines.push(`  class ${ids.join(',')} ${kind}`)
  }
  for (const zone of zones) {
    if ([...nodes.values()].some((node) => zoneKey(node.scope, node.kind) === zone.key)) {
      lines.push(`  style ${zone.id} fill:#FFFCF6,stroke:#D8D1D4,stroke-width:1.25px,stroke-dasharray:8 6,color:#6F686C`)
    }
  }

  lines.push('  linkStyle default stroke:#6F686C,stroke-width:1.25px,fill:none')

  return lines.join('\n')
}
