'use client'

import { configurationStatus } from '@/lib/architecture/fact-ledger'
import type { ReactNode } from 'react'
import {
  CircleStackIcon,
  LockClosedIcon,
} from '@heroicons/react/24/outline'
import { MermaidDiagram } from './mermaid-diagram'
import type { ArchitectureData, UnifiedThreat } from '@/lib/models/types'
import Link from 'next/link'
import {
  ARCHITECTURE_DIAGRAM_MAX_FLOWS,
  ARCHITECTURE_DIAGRAM_MAX_NODES,
  buildArchitectureMermaid,
} from '@/lib/architecture/mermaid'
import styles from './architecture-viewer.module.css'

type ArchitectureViewerProps = {
  architecture: ArchitectureData
  threats?: UnifiedThreat[]
  analysisId?: string
}

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'magenta'

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-[#d9e0d7] bg-[#f4f6f2] text-[#4e5b50]',
  info: 'border-[#bdcfc0] bg-[#edf4ed] text-[#385d40]',
  success: 'border-[#b9d5bf] bg-[#edf7ee] text-[#305e3a]',
  warning: 'border-[#e1c5a9] bg-[#fcf3e9] text-[#815a35]',
  danger: 'border-[#e4b7af] bg-[#fff0ec] text-[#8b3f37]',
  magenta: 'border-[#d5d1da] bg-[#f6f3f7] text-[#665c6b]',
}

const LEGEND = [
  { label: 'Actor / external', color: 'border-[#333333] bg-[#f1f1f0]', shape: 'rounded-full' },
  { label: 'Component', color: 'border-[#666666] bg-[#f5f5f3]', shape: 'rounded-[6px]' },
  { label: 'Data store', color: 'border-[#218848] bg-white', shape: 'rounded-[50%]' },
  { label: 'T finding', color: 'border-[#b76e60] bg-white text-[#96564b]', shape: 'rounded-[6px]' },
] as const

export function ArchitectureViewer({ architecture, threats = [], analysisId }: ArchitectureViewerProps) {
  const {
    systemDescription,
    components = [],
    dataFlows = [],
    dataStores = [],
    trustBoundaries = [],
    apiEndpoints = [],
    externalEntities = [],
    deploymentInfo,
    techFlags,
    detailedTopology,
  } = architecture
  const architectureDiagram = buildArchitectureMermaid(architecture, threats)
  const hasActorReferences = detailedTopology?.actors?.some((actor) => actor.reference) ?? false
  const totalDiagramNodes = new Set([
    ...components.map((component) => component.name),
    ...externalEntities,
    ...dataFlows.flatMap((flow) => [flow.from, flow.to]),
  ]).size
  const diagramWasSimplified = totalDiagramNodes > ARCHITECTURE_DIAGRAM_MAX_NODES
    || dataFlows.length > ARCHITECTURE_DIAGRAM_MAX_FLOWS

  return (
    <div className={`${styles.workspace} space-y-7 text-[#111111]`}>
      {architecture.sourceEvidence && (
        <section aria-labelledby="source-coverage" className={`${styles.coverage} border border-[#cacac7] bg-[#fcfcfb] p-5`}>
          <SectionHeading id="source-coverage" title="Source coverage" />
          <p className="mt-3 text-sm leading-6">{architecture.sourceEvidence.sections.length} original source sections retained. Extraction: {architecture.sourceEvidence.extraction.mode === 'full' ? 'full context' : 'complete section groups'}; {architecture.sourceEvidence.extraction.failed.length} failed sections.</p>
          {Object.entries(architecture.sourceEvidence.analystDelivery ?? {}).map(([analyst, ids]) => (
            <p className="mt-1 text-sm" key={analyst}>{analyst}: {new Set(ids).size} of {architecture.sourceEvidence!.sections.length} sections delivered in successful analysis passes.</p>
          ))}
          <p className="mt-3 text-sm text-[#666666]">Delivery is not proof of understanding or exhaustive threat detection. Missing extraction or analyst delivery blocks debate. Source offsets refer to the retained, secret-redacted input.</p>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-semibold">Inspect original source sections</summary>
            <div className="mt-3 space-y-3">{architecture.sourceEvidence.sections.map(section => (
              <details key={section.id} className="border-t border-[#cacac7] pt-3">
                <summary className="cursor-pointer">{section.id} · {section.heading} · {section.end - section.start} characters{architecture.sourceEvidence!.extraction.failed.includes(section.id) ? ' · extraction failed' : ''}</summary>
                <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{section.text}</pre>
              </details>
            ))}</div>
          </details>
        </section>
      )}
      {systemDescription && (
        <section aria-labelledby="architecture-system-description">
          <SectionHeading id="architecture-system-description" title="System description" />
          <p className="w-full rounded-sm border border-[#cacac7] bg-[#fcfcfb] p-4 text-sm leading-6 text-[#444444]">
            {systemDescription}
          </p>
        </section>
      )}

      {(components.length > 0 || dataFlows.length > 0 || externalEntities.length > 0) && (
        <section aria-labelledby="architecture-canvas-title">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 id="architecture-canvas-title" className="workbench-heading text-base">Threat architecture canvas</h3>
              <p className="mt-1 text-sm text-[#666666]">Trust zones and data paths, with finding references attached to each component.</p>
            </div>
            <div className="flex max-w-2xl flex-wrap justify-end gap-x-3 gap-y-1.5 text-xs font-medium text-[#666666]" aria-label="Diagram legend">
              {LEGEND.map(({ color, label, shape }) => (
                <span key={label} className="inline-flex items-center gap-1.5">
                  <span className={`grid h-4 min-w-4 place-items-center border px-0.5 text-xs font-bold leading-none ${shape} ${color}`} aria-hidden="true">
                    {label.startsWith('T ') ? 'T' : ''}
                  </span>
                  {label}
                </span>
              ))}
            </div>
          </div>
          <div className={`${styles.canvas} overflow-hidden border border-[#cacac7] bg-white shadow-[0_8px_24px_rgba(44,40,43,0.05)]`}>
            <MermaidDiagram chart={architectureDiagram} />
          </div>
          {threats.length > 0 && <details className="mt-3 border border-[#cacac7] bg-[#fcfcfb] p-4" open={diagramWasSimplified}><summary className="cursor-pointer text-sm font-semibold">Readable finding and component list ({threats.length})</summary><ul className="mt-3 grid gap-2 text-xs sm:grid-cols-2">{threats.map((threat) => <li key={threat.id} className="border-b border-[#e4e4e2] pb-2"><strong className="block">{threat.component}</strong>{analysisId ? <Link href={`/results/${analysisId}?section=findings&finding=${encodeURIComponent(threat.id)}`} className="underline">{threat.displayId ?? threat.id} · {threat.title || threat.description}</Link> : <span>{threat.title || threat.description}</span>}</li>)}</ul></details>}
          {diagramWasSimplified ? (
            <p className="mt-2 text-xs leading-5 text-[#666666]">
              Large architecture: the canvas prioritizes finding-linked components and shows up to {ARCHITECTURE_DIAGRAM_MAX_NODES} nodes and {ARCHITECTURE_DIAGRAM_MAX_FLOWS} flows. The complete inventory remains in the tables below.
            </p>
          ) : null}
          {threats.length > 0 && <ThreatControlMap threats={threats} analysisId={analysisId} />}
        </section>
      )}

      {detailedTopology?.actors && detailedTopology.actors.length > 0 && (
        <section aria-labelledby="architecture-actors">
          <SectionHeading id="architecture-actors" title="Actors & roles" count={detailedTopology.actors.length} />
          <ArchitectureTable headers={['Name', 'Description', 'Privilege', ...(hasActorReferences ? ['Reference'] : [])]}>
            {detailedTopology.actors.map((actor, index) => (
              <tr key={`${actor.name}-${index}`}>
                <td className="px-4 py-3 font-semibold text-[#111111]">{actor.name}</td>
                <td className="px-4 py-3 leading-6 text-[#444444]">{actor.description}</td>
                <td className="px-4 py-3"><Badge tone={privilegeTone(actor.privilegeLevel)}>{actor.privilegeLevel}</Badge></td>
                {hasActorReferences && <td className="px-4 py-3 font-mono text-xs text-[#666666]">{actor.reference || '—'}</td>}
              </tr>
            ))}
          </ArchitectureTable>
        </section>
      )}

      {detailedTopology?.environmentVars && detailedTopology.environmentVars.length > 0 && (
        <section aria-labelledby="architecture-environment-variables">
          <SectionHeading id="architecture-environment-variables" title="Environment variables" count={detailedTopology.environmentVars.length} />
          <ArchitectureTable headers={['Name', 'Value', 'Exposure', 'Component']}>
            {detailedTopology.environmentVars.map((envVar, index) => (
              <tr key={`${envVar.name}-${index}`}>
                <td className="px-4 py-3 font-mono text-xs font-semibold text-[#111111]">{envVar.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-[#444444]">{envVar.isSensitive ? '[REDACTED]' : envVar.value || '—'}</td>
                <td className="px-4 py-3"><Badge tone={envVar.isSensitive ? 'danger' : 'neutral'}>{envVar.isSensitive ? 'Sensitive' : 'Public'}</Badge></td>
                <td className="px-4 py-3 text-[#444444]">{envVar.component}</td>
              </tr>
            ))}
          </ArchitectureTable>
        </section>
      )}

      {detailedTopology?.securityConfigs && detailedTopology.securityConfigs.length > 0 && (
        <section aria-labelledby="architecture-security-configurations">
          <SectionHeading id="architecture-security-configurations" title="Security configurations" count={detailedTopology.securityConfigs.length} />
          <ArchitectureTable headers={['Component', 'Type', 'Status', 'Details']}>
            {detailedTopology.securityConfigs.map((config, index) => (
              <tr key={`${config.component}-${config.configType}-${index}`}>
                <td className="px-4 py-3 font-semibold text-[#111111]">{config.component}</td>
                <td className="px-4 py-3"><Badge tone="info">{config.configType}</Badge></td>
                <td className="px-4 py-3"><Badge tone={configurationStatus(config.details, config.isEnabled) === 'enabled' ? 'success' : configurationStatus(config.details, config.isEnabled) === 'disabled' ? 'danger' : 'neutral'}>{configurationStatus(config.details, config.isEnabled)}</Badge></td>
                <td className="px-4 py-3 leading-6 text-[#444444]">{config.details}</td>
              </tr>
            ))}
          </ArchitectureTable>
        </section>
      )}

      {components.length > 0 && (
        <section aria-labelledby="architecture-components">
          <SectionHeading id="architecture-components" title="Components" count={components.length} />
          <ArchitectureTable headers={['Name', 'Type', 'Scope', 'Relationship', 'Technology']}>
            {components.map((component, index) => (
              <tr key={`${component.name}-${index}`}>
                <td className="px-4 py-3 font-semibold text-[#111111]">{component.name}</td>
                <td className="px-4 py-3"><Badge tone="info">{component.type}</Badge></td>
                <td className="px-4 py-3"><Badge tone={scopeTone(component.scope)}>{component.scope}</Badge></td>
                <td className="px-4 py-3 text-xs text-[#444444]">{component.relationship ?? 'Not classified'}{component.scopeEvidence && <p className="mt-1">{component.scopeEvidence}</p>}</td>
                <td className="px-4 py-3 leading-6 text-[#444444]">{component.technology || '—'}</td>
              </tr>
            ))}
          </ArchitectureTable>
        </section>
      )}

      {dataFlows.length > 0 && (
        <section aria-labelledby="architecture-data-flows">
          <SectionHeading id="architecture-data-flows" title="Data flows" count={dataFlows.length} />
          <ArchitectureTable headers={['From', 'Protocol', 'To', 'Data']}>
            {dataFlows.map((flow, index) => (
              <tr key={`${flow.from}-${flow.to}-${index}`}>
                <td className="px-4 py-3 font-semibold text-[#111111]">{flow.from}</td>
                <td className="px-4 py-3"><Badge tone="neutral" mono>{flow.protocol || '—'}</Badge></td>
                <td className="px-4 py-3 font-semibold text-[#111111]">{flow.to}</td>
                <td className="px-4 py-3 leading-6 text-[#444444]">{flow.data}</td>
              </tr>
            ))}
          </ArchitectureTable>
        </section>
      )}

      {(trustBoundaries.length > 0 || dataStores.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {trustBoundaries.length > 0 && (
            <FactList
              id="architecture-trust-boundaries"
              title="Trust boundaries"
              items={trustBoundaries}
              icon={<LockClosedIcon className="h-4 w-4" />}
              tone="warning"
            />
          )}
          {dataStores.length > 0 && (
            <FactList
              id="architecture-data-stores"
              title="Data stores"
              items={dataStores}
              icon={<CircleStackIcon className="h-4 w-4" />}
              tone="success"
            />
          )}
        </div>
      )}

      {apiEndpoints.length > 0 && (
        <section aria-labelledby="architecture-api-endpoints">
          <SectionHeading id="architecture-api-endpoints" title="API endpoints" count={apiEndpoints.length} />
          <div className="grid overflow-hidden rounded-sm border border-[#cacac7] bg-white sm:grid-cols-2 lg:grid-cols-3">
            {apiEndpoints.map((endpoint, index) => (
              <code key={`${endpoint}-${index}`} className="border-b border-[#e4e4e2] px-4 py-3 font-mono text-xs leading-5 text-[#111111] last:border-b-0 sm:border-r sm:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(2n)]:border-r lg:[&:nth-child(3n)]:border-r-0">
                {endpoint}
              </code>
            ))}
          </div>
        </section>
      )}

      {externalEntities.length > 0 && (
        <section aria-labelledby="architecture-external-entities">
          <SectionHeading id="architecture-external-entities" title="External entities" count={externalEntities.length} />
          <div className="flex flex-wrap gap-2 rounded-sm border border-[#cacac7] bg-[#fcfcfb] p-4">
            {externalEntities.map((entity, index) => <Badge key={`${entity}-${index}`} tone="magenta">{entity}</Badge>)}
          </div>
        </section>
      )}

      {deploymentInfo && (
        <section aria-labelledby="architecture-deployment-information">
          <SectionHeading id="architecture-deployment-information" title="Deployment information" />
          <p className="w-full rounded-sm border border-[#cacac7] bg-[#fcfcfb] p-4 text-sm leading-6 text-[#444444]">{deploymentInfo}</p>
        </section>
      )}

      {techFlags && Object.keys(techFlags).length > 0 && (
        <section aria-labelledby="architecture-technology-flags">
          <SectionHeading id="architecture-technology-flags" title="Technology flags" count={Object.keys(techFlags).length} />
          <div className="grid overflow-hidden rounded-sm border border-[#cacac7] bg-white sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(techFlags).map(([key, value]) => (
              <div key={key} className="flex min-h-14 items-center justify-between gap-3 border-b border-[#e4e4e2] px-4 py-3 sm:border-r sm:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(2n)]:border-r lg:[&:nth-child(4n)]:border-r-0">
                <span className="text-sm font-medium text-[#111111]">{formatFlagLabel(key)}</span>
                <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${value ? 'text-[#218848]' : 'text-[#666666]'}`}>
                  <span className={`h-2 w-2 rounded-full ${value ? 'bg-[#218848]' : 'bg-[#cacac7]'}`} aria-hidden="true" />
                  {value ? 'Detected' : 'Not detected'}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function SectionHeading({ id, title, count }: { id: string; title: string; count?: number }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h3 id={id} className="workbench-heading text-base">{title}</h3>
      {count != null && <span className="font-mono text-xs font-semibold text-[#666666]">{count}</span>}
    </div>
  )
}

function ArchitectureTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className={`${styles.tableWrap} overflow-hidden border border-[#cacac7] bg-white`}>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[#fcfcfb]">
            <tr>
              {headers.map((header) => (
                <th key={header} scope="col" className="whitespace-nowrap px-4 py-3 text-xs font-bold uppercase tracking-[0.08em] text-[#666666]">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="[&_tr]:border-t [&_tr]:border-[#e4e4e2] [&_tr]:transition-colors [&_tr:hover]:bg-[#f1f1f0]/60">
            {children}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Badge({ children, tone = 'neutral', mono = false }: { children: ReactNode; tone?: BadgeTone; mono?: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-sm border px-2 py-1 text-xs font-semibold ${mono ? 'font-mono' : ''} ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  )
}

function FactList({ id, title, items, icon, tone }: { id: string; title: string; items: string[]; icon: ReactNode; tone: BadgeTone }) {
  return (
    <section className="overflow-hidden rounded-sm border border-[#cacac7] bg-white" aria-labelledby={id}>
      <div className="flex items-center gap-2 border-b border-[#e4e4e2] bg-[#fcfcfb] px-4 py-3">
        <span className={tone === 'warning' ? 'text-[#f96715]' : 'text-[#218848]'} aria-hidden="true">{icon}</span>
        <h3 id={id} className="workbench-heading text-base">{title}</h3>
        <span className="ml-auto font-mono text-xs font-semibold text-[#666666]">{items.length}</span>
      </div>
      <ul className="divide-y divide-[#e4e4e2]">
        {items.map((item, index) => <li key={`${item}-${index}`} className="px-4 py-3 text-sm leading-6 text-[#444444]">{item}</li>)}
      </ul>
    </section>
  )
}

function ThreatControlMap({ threats, analysisId }: { threats: UnifiedThreat[]; analysisId?: string | undefined }) {
  if (threats.length === 0) return null
  return (
    <section className="mt-4 border-t border-[#e4e4e2] pt-4" aria-labelledby="threat-control-map-title">
      <h4 id="threat-control-map-title" className="workbench-heading text-sm">Findings and proposed actions</h4>
      <p className="mt-1 text-sm text-[#666666]">These are recommendations from the assessment. Referenced control IDs alone do not establish a control definition or that it operates.</p>
      <div className={`${styles.threatMap} mt-3 overflow-hidden border border-[#cacac7]`}>
        {threats.map((threat) => {
          return (
            <div key={threat.id} className={`${styles.threatMapRow} grid border-b border-[#e4e4e2] bg-white last:border-b-0`}>
              <div className="min-w-0 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{threat.displayId ?? threat.id}</Badge>
                  <span className="text-xs font-bold uppercase tracking-[0.08em] text-[#666666]">{threat.component}</span>
                </div>
                <p className="mt-2 text-sm font-semibold leading-6 text-[#111111]">{threat.title || threat.description}</p>
                {analysisId && <Link href={`/results/${analysisId}?section=findings&finding=${encodeURIComponent(threat.id)}`} className="mt-2 inline-block text-xs font-semibold underline">Review finding →</Link>}
              </div>
              <div className="min-w-0 border-t border-[#e4e4e2] bg-[#fcfcfb] p-3 lg:border-l lg:border-t-0">
                <p className="text-[10px] font-bold uppercase tracking-wide text-[#666666]">Proposed mitigation</p>
                <p className={styles.threatMapMitigation}>{threat.mitigation || 'No mitigation was recorded for this finding.'}</p>
                {threat.controlReference && <p className="mt-2 text-xs text-[#666666]">Source control reference: {threat.controlReference}. Verify its definition and operation in the source and environment.</p>}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function scopeTone(scope: string): BadgeTone {
  const normalized = scope.toLowerCase()
  if (normalized.includes('public')) return 'danger'
  if (normalized.includes('dmz') || normalized.includes('edge')) return 'warning'
  if (normalized.includes('cloud') || normalized.includes('external')) return 'magenta'
  if (normalized.includes('internal')) return 'info'
  return 'neutral'
}

function privilegeTone(level: string): BadgeTone {
  const normalized = level.toLowerCase()
  if (normalized.includes('admin') || normalized.includes('system')) return 'danger'
  if (normalized.includes('service')) return 'info'
  if (normalized.includes('public')) return 'warning'
  return 'neutral'
}

function formatFlagLabel(key: string): string {
  return key
    .replace(/^has/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
}
