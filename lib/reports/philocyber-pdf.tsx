import { COLOR, styles } from './pdf-styles'
import { scoreLabel, severityLabel } from '@/lib/models/scoring'
import { evidenceState, reviewCounts, sortReviewQueue } from '@/lib/ui/review-queue'
/* eslint-disable jsx-a11y/alt-text -- @react-pdf/renderer Image is not a DOM img and does not expose an alt prop. */
import 'server-only'

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  Document,
  Font,
  Image,
  Page,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer'
import type { ArchitectureData, UnifiedThreat } from '@/lib/models/types'
import type { RAGTraceSnapshot } from '@/lib/rag/trace'
import type { RunInputBundle } from '@/lib/runs/input-bundle'
import { describeRunExecution } from '@/lib/reports/execution-status'

Font.register({
  family: 'Inter',
  fonts: [
    { src: join(process.cwd(), 'app', 'fonts', 'Inter-Regular.ttf'), fontWeight: 400 },
    { src: join(process.cwd(), 'app', 'fonts', 'Inter-Medium.ttf'), fontWeight: 500 },
    { src: join(process.cwd(), 'app', 'fonts', 'Inter-SemiBold.ttf'), fontWeight: 600 },
    { src: join(process.cwd(), 'app', 'fonts', 'Inter-SemiBold.ttf'), fontWeight: 700 },
  ],
})

Font.register({
  family: 'Archivo',
  fonts: [
    { src: join(process.cwd(), 'app', 'fonts', 'Archivo-SemiBold.ttf'), fontWeight: 600 },
    { src: join(process.cwd(), 'app', 'fonts', 'Archivo-Bold.ttf'), fontWeight: 700 },
  ],
})

Font.register({
  family: 'JetBrains Mono',
  fonts: [
    { src: join(process.cwd(), 'app', 'fonts', 'JetBrainsMono-Regular.ttf'), fontWeight: 400 },
    { src: join(process.cwd(), 'app', 'fonts', 'JetBrainsMono-Medium.ttf'), fontWeight: 500 },
  ],
})

export type PhiloCyberPdfReport = {
  id: string
  title: string
  status: string
  draft?: boolean
  createdAt: Date
  completedAt: Date | null
  durationSeconds: number | null
  systemDescription: string | null
  architecture: ArchitectureData | null
  threats: UnifiedThreat[]
  debateSummary: string | null
  ragTrace: RAGTraceSnapshot | null
  inputBundle: RunInputBundle
  pipelineErrors: string[]
  errorMessage?: string | null
}

function ascii(value: unknown, max = Number.POSITIVE_INFINITY): string {
  return String(value ?? '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .normalize('NFKD')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max)
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

function reportDate(value: Date | null): string {
  if (!value) return 'Not completed'
  return value.toISOString().slice(0, 10)
}

function seconds(value: number | null): string {
  if (value == null) return '-'
  if (value < 60) return `${value}s`
  return `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, '0')}s`
}

function priorityColor(priority: UnifiedThreat['priority']): string {
  if (priority === 'critical') return COLOR.red
  if (priority === 'high') return COLOR.orange
  if (priority === 'medium') return COLOR.yellowHover
  return COLOR.blue
}

function Header({ logo, label, landscape = false }: { logo: string; label: string; landscape?: boolean }) {
  return (
    <View style={[styles.header, ...(landscape ? [styles.headerLandscape] : [])]} fixed>
      <Image src={logo} style={styles.headerLogo} />
      <Text style={styles.headerLabel}>{ascii(label, 80)}</Text>
    </View>
  )
}

function Footer({ runId, landscape = false }: { runId: string; landscape?: boolean }) {
  return (
    <>
      <Text style={[styles.footerLeft, ...(landscape ? [styles.footerLeftLandscape] : [])]} fixed>
        Argus · PhiloCyber
      </Text>
      <Text style={[styles.footerRight, ...(landscape ? [styles.footerRightLandscape] : [])]} fixed>
        Run {ascii(runId).slice(-12)}
      </Text>
    </>
  )
}

function SectionLead({ title, intro }: { title: string; intro?: string }) {
  return (
    <>
      <Text style={styles.sectionTitle}>{ascii(title)}</Text>
      <View style={styles.sectionRule} />
      {intro ? <Text style={styles.sectionIntro}>{ascii(intro)}</Text> : null}
    </>
  )
}

type ReportNode = {
  id: string
  name: string
  type: string
  scope: string
  zone: 'external' | 'public' | 'dmz' | 'internal'
  kind: 'actor' | 'service' | 'gateway' | 'store' | 'queue' | 'external'
  threatIds: string[]
  controlCount: number
}

function nodeKey(value: string): string {
  return ascii(value).toLowerCase().replace(/\((external|public|internal)\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function findNodeByName<T extends ReportNode>(nodes: T[], value: string): T | undefined {
  const normalized = nodeKey(value)
  const exact = nodes.find((node) => nodeKey(node.name) === normalized)
  if (exact) return exact

  if (normalized === 'temporal') {
    return nodes.find((node) => nodeKey(node.name) === 'temporal cloud')
      ?? nodes.find((node) => nodeKey(node.name) === 'temporal platform')
  }
  if (normalized.endsWith('workflow') && !normalized.startsWith('temporal')) {
    return nodes.find((node) => nodeKey(node.name) === 'temporal workflows')
  }
  if (normalized === 'service e') return undefined

  if (normalized.length < 5) return undefined
  return nodes
    .filter((node) => {
      const current = nodeKey(node.name)
      return current.length >= 5 && (current.includes(normalized) || normalized.includes(current))
    })
    .sort((a, b) => Math.abs(nodeKey(a.name).length - normalized.length) - Math.abs(nodeKey(b.name).length - normalized.length))[0]
}

function nodeKind(name: string, type: string, stores: string[]): ReportNode['kind'] {
  const value = `${name} ${type}`.toLowerCase()
  if (stores.some((store) => nodeKey(store) === nodeKey(name)) || /(database|data store|postgres|mysql|redis|cache|bucket|storage)/.test(value)) return 'store'
  if (/(queue|broker|kafka|rabbit|sqs|sns|event bus)/.test(value)) return 'queue'
  if (/(gateway|proxy|load balancer|firewall|waf)/.test(value)) return 'gateway'
  if (/(user|actor|browser|client)/.test(value)) return 'actor'
  if (/(external|third party|provider|cloud)/.test(value)) return 'external'
  return 'service'
}

function nodeZone(scope: string, kind: ReportNode['kind']): ReportNode['zone'] {
  const value = scope.toLowerCase()
  if (value.includes('external') || value.includes('cloud')) return 'external'
  if (value.includes('public') || value.includes('untrusted')) return 'public'
  if (value.includes('dmz') || value.includes('edge')) return 'dmz'
  if (value.includes('internal')) return 'internal'
  if (kind === 'external') return 'external'
  return 'internal'
}

function diagramNodes(architecture: ArchitectureData, threats: UnifiedThreat[]): ReportNode[] {
  const nodes = new Map<string, ReportNode>()
  const ensure = (name: string, type = 'service', scope = 'internal') => {
    const normalized = nodeKey(name)
    const existing = findNodeByName([...nodes.values()], name)
    if (existing) return existing
    const kind = nodeKind(name, type, architecture.dataStores)
    const linked = threats.filter((threat) => {
      const candidates = [threat.component, ...(threat.traceability?.components ?? [])].map(nodeKey)
      return candidates.some((candidate) => candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate))
    })
    const node: ReportNode = {
      id: `node-${nodes.size + 1}`,
      name: ascii(name, 70),
      type: ascii(type, 30),
      scope: ascii(scope, 30),
      zone: nodeZone(scope, kind),
      kind,
      threatIds: linked.map((threat) => threat.displayId ?? threat.id).slice(0, 3),
      controlCount: linked.filter((threat) => threat.controlReference || threat.mitigation).length,
    }
    nodes.set(normalized, node)
    return node
  }
  architecture.components.forEach((component) => ensure(component.name, component.type, component.scope))
  architecture.externalEntities.forEach((name) => ensure(name, 'external entity', 'external'))
  architecture.dataFlows.forEach((flow) => { ensure(flow.from); ensure(flow.to) })
  return [...nodes.values()]
}

function ArchitectureDiagram({ architecture, threats }: { architecture: ArchitectureData; threats: UnifiedThreat[] }) {
  const nodes = diagramNodes(architecture, threats)
  const zones = (['public', 'dmz', 'internal', 'external'] as const)
    .map((key) => ({ key, nodes: nodes.filter((node) => node.zone === key) }))
    .filter((zone) => zone.nodes.length > 0)
  return (
    <View>
      <View style={{ gap: 5 }}>
        {zones.map((zone) => (
          <View key={zone.key} style={{ flexDirection: 'row', gap: 10, padding: 6, borderWidth: 1, borderColor: COLOR.divider, borderRadius: 9, backgroundColor: COLOR.surface }}>
            <View style={{ width: 94, paddingTop: 5 }}><Text style={{ color: COLOR.green, fontSize: 8, fontWeight: 700, letterSpacing: 1 }}>{zone.key.toUpperCase()}</Text><Text style={{ marginTop: 3, color: COLOR.muted, fontSize: 7 }}>{zone.nodes.length} systems</Text></View>
            <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
              {zone.nodes.map((node) => (
                <View key={node.id} style={{ width: '24%', minHeight: 28, padding: 4, borderWidth: 1, borderColor: COLOR.divider, borderRadius: 5, backgroundColor: COLOR.white }}>
                  <Text style={{ fontSize: 7.3, fontWeight: 600, lineHeight: 1.2 }}>{ascii(node.name)}</Text>
                  {node.threatIds.length > 0 ? <Text style={{ marginTop: 2, color: COLOR.green, fontSize: 6 }}>{node.threatIds.length} linked finding{node.threatIds.length === 1 ? '' : 's'}</Text> : null}
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}

function ReportDocument({ report, logo }: { report: PhiloCyberPdfReport; logo: string }) {
  const priorityCounts = {
    critical: report.threats.filter((threat) => threat.scoringStatus !== 'unscored' && threat.priority === 'critical').length,
    high: report.threats.filter((threat) => threat.scoringStatus !== 'unscored' && threat.priority === 'high').length,
    medium: report.threats.filter((threat) => threat.scoringStatus !== 'unscored' && threat.priority === 'medium').length,
    low: report.threats.filter((threat) => threat.scoringStatus !== 'unscored' && threat.priority === 'low').length,
  }
  const methodologies = [...new Set(report.threats.flatMap((threat) => threat.methodologies ?? [threat.methodology]))]
  const architecture = report.architecture
  const config = report.inputBundle.executionConfig
  const retrievalSources = report.ragTrace
    ? new Set(report.ragTrace.entries.flatMap((entry) => entry.selected.map((source) => `${source.domain}:${source.source}`))).size
    : 0
  const threatPages = chunkArray(sortReviewQueue(report.threats), 2)
  const queue = reviewCounts(report.threats)
  const execution = describeRunExecution({
    status: report.status,
    errorMessage: report.errorMessage,
    pipelineErrors: report.pipelineErrors,
    threatCount: report.threats.length,
  })
  const findingsLabel = execution.kind === 'failed' && report.threats.length === 0 ? 'Not produced' : report.threats.length
  return (
    <Document
      title={`${report.title} - Threat model report`}
      author="PhiloCyber"
      subject="Agentic threat model analysis"
      keywords="PhiloCyber, security, threat model, architecture, findings"
      creator="Argus"
    >
      <Page size="A4" style={styles.cover}>
        <View style={styles.coverPanel} />
        <View style={styles.coverOrb} />
        <View style={styles.coverRail} />
        <Image src={logo} style={styles.coverLogo} />
        <View style={styles.coverRule} />
        <Text style={styles.coverKicker}>SECURITY REVIEW / ASSESSMENT RECORD</Text>
        <Text style={styles.coverTitle}>{ascii(report.title || 'Threat model report', 180)}</Text>
        <Text style={styles.coverSubtitle}>{ascii(execution.detail, 400)}</Text>
        {report.draft && <Text style={{ marginTop: 12, fontSize: 10, fontWeight: 700 }}>DRAFT · Reviewer decisions pending or analysis incomplete</Text>}
        <View style={styles.coverMetrics}>
          {[
            [findingsLabel, 'Findings'],
            [priorityCounts.critical, 'Critical'],
            [architecture?.components.length ?? 0, 'Components'],
            [methodologies.length, 'Methods'],
          ].map(([value, label]) => (
            <View key={label} style={styles.coverMetric}>
              <Text style={styles.coverMetricValue}>{value}</Text>
              <Text style={styles.coverMetricLabel}>{label}</Text>
            </View>
          ))}
        </View>
        <View style={styles.coverMeta}>
          <View>
            <Text style={styles.coverMetaText}>Analysis ID  {ascii(report.id)}</Text>
            <Text style={[styles.coverMetaText, { marginTop: 5 }]}>Completed  {reportDate(report.completedAt)}</Text>
          </View>
          <View>
            <Text style={[styles.coverMetaText, { textAlign: 'right' }]}>Status  {ascii(report.status).toUpperCase()}</Text>
            <Text style={[styles.coverMetaText, { marginTop: 5, textAlign: 'right' }]}>Argus · PhiloCyber</Text>
          </View>
        </View>
      </Page>

      <Page size="A4" style={styles.page}>
        <Header logo={logo} label="Threat model report" />
        <Footer runId={report.id} />
        <SectionLead title="What We Know" intro={ascii(execution.detail, 500)} />
        {execution.kind !== 'completed' ? (
          <View style={styles.warning}>
            <Text style={{ fontWeight: 700 }}>{ascii(execution.headline)}</Text>
            <Text style={{ marginTop: 3 }}>{ascii(execution.detail, 1000)}</Text>
          </View>
        ) : report.pipelineErrors.length ? (
          <View style={styles.warning}>
            <Text style={{ fontWeight: 700 }}>Partial analyst coverage</Text>
            <Text style={{ marginTop: 3 }}>{ascii(report.pipelineErrors.join('; '), 1000)}</Text>
          </View>
        ) : null}
        <View style={styles.metricsRow}>
          {([
            ['Critical', priorityCounts.critical, COLOR.red],
            ['High', priorityCounts.high, COLOR.orange],
            ['Medium', priorityCounts.medium, COLOR.yellowHover],
            ['Low', priorityCounts.low, COLOR.blue],
            ['Runtime', seconds(report.durationSeconds), COLOR.charcoal],
          ] as const).map(([label, value, color]) => (
            <View key={label} style={styles.metric}>
              <Text style={[styles.metricValue, { color }]}>{value}</Text>
              <Text style={styles.metricLabel}>{label}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.subheading}>System description</Text>
        <View style={styles.summaryBox}>
          <Text style={styles.summaryText}>{ascii(report.systemDescription || architecture?.systemDescription || 'No inferred system description was stored.', 5000)}</Text>
        </View>
        <Text style={styles.subheading}>Review coverage</Text>
        <Text style={styles.body}>{queue.pending} findings await a reviewer decision; {queue.actionable} High/Critical findings meet the current source, applicability, and score checks. Severity totals above do not establish readiness, exploitability, or control operation.</Text>
        <View style={styles.twoCol}>
          <View style={styles.column}>
            <View style={styles.factRow}><Text style={styles.factLabel}>Methods</Text><Text style={styles.factValue}>{ascii(methodologies.join(', ') || 'Not recorded')}</Text></View>
            <View style={styles.factRow}><Text style={styles.factLabel}>Components</Text><Text style={styles.factValue}>{architecture?.components.length ?? 0}</Text></View>
            <View style={styles.factRow}><Text style={styles.factLabel}>Data flows</Text><Text style={styles.factValue}>{architecture?.dataFlows.length ?? 0}</Text></View>
          </View>
          <View style={styles.column}>
            <View style={styles.factRow}><Text style={styles.factLabel}>Reviewed</Text><Text style={styles.factValue}>{report.threats.filter((threat) => threat.reviewStatus && threat.reviewStatus !== 'pending').length} / {report.threats.length}</Text></View>
            <View style={styles.factRow}><Text style={styles.factLabel}>RAG sources</Text><Text style={styles.factValue}>{retrievalSources}</Text></View>
            <View style={styles.factRow}><Text style={styles.factLabel}>Version</Text><Text style={styles.factValue}>{ascii(report.inputBundle.versionHash, 18)}</Text></View>
          </View>
        </View>
      </Page>

      {architecture ? (
        <Page size="A4" orientation="landscape" style={styles.pageLandscape}>
          <Header logo={logo} label="Threat Architecture" landscape />
          <Footer runId={report.id} landscape />
          <SectionLead title="Threat Architecture" intro="Systems grouped by their recorded trust zone. Follow each route and boundary crossing in the complete Data Flow Register on the next page." />
          <View style={styles.diagramFrame}>
            <ArchitectureDiagram architecture={architecture} threats={report.threats} />
          </View>
        </Page>
      ) : null}

      {architecture ? (
        <Page size="A4" style={styles.page}>
          <Header logo={logo} label="Data Flow Register" />
          <Footer runId={report.id} />
          <SectionLead title="Data Flow Register" intro="Complete directional routes connecting the systems in the zone map." />
          <View style={styles.table}>
            <View style={styles.tableHeader} fixed>
              <View style={[styles.tableCell, { width: '7%' }]}><Text style={styles.tableHeadText}>#</Text></View>
              <View style={[styles.tableCell, { width: '21%' }]}><Text style={styles.tableHeadText}>From</Text></View>
              <View style={[styles.tableCell, { width: '21%' }]}><Text style={styles.tableHeadText}>To</Text></View>
              <View style={[styles.tableCell, { width: '14%' }]}><Text style={styles.tableHeadText}>Protocol</Text></View>
              <View style={[styles.tableCell, { width: '37%' }]}><Text style={styles.tableHeadText}>Data</Text></View>
            </View>
            {architecture.dataFlows.map((flow, index) => (
              <View key={`${flow.from}-${flow.to}-${index}`} style={styles.tableRow} wrap={false}>
                <View style={[styles.tableCell, { width: '7%' }]}><Text style={styles.tableText}>{index + 1}</Text></View>
                <View style={[styles.tableCell, { width: '21%' }]}><Text style={styles.tableText}>{ascii(flow.from, 80)}</Text></View>
                <View style={[styles.tableCell, { width: '21%' }]}><Text style={styles.tableText}>{ascii(flow.to, 80)}</Text></View>
                <View style={[styles.tableCell, { width: '14%' }]}><Text style={styles.tableText}>{ascii(flow.protocol || '-', 30)}</Text></View>
                <View style={[styles.tableCell, { width: '37%' }]}><Text style={styles.tableText}>{ascii(flow.data, 180)}</Text></View>
              </View>
            ))}
          </View>
        </Page>
      ) : null}

      {threatPages.map((pageThreats, pageIndex) => (
        <Page key={`findings-${pageIndex}`} size="A4" style={styles.page}>
          <Header logo={logo} label="Threats and Controls" />
          <Footer runId={report.id} />
          {pageIndex === 0
            ? <SectionLead title="Threats and Controls" intro="Prioritized threats with review state, impact and recommended mitigation." />
            : <Text style={[styles.subheading, { marginTop: 0 }]}>Threats and Controls - continued</Text>}
          {pageThreats.map((threat) => (
            <View key={threat.id} style={styles.threat} wrap={false}>
              <View style={styles.threatHeading} minPresenceAhead={26}>
                <Text style={styles.threatIdText}>{ascii(threat.displayId ?? threat.id, 24)}  /  {ascii(threat.component || 'Unknown component', 60)}</Text>
                <Text style={[styles.badge, { color: priorityColor(threat.priority), borderWidth: 1, borderColor: priorityColor(threat.priority) }]}>{severityLabel(threat)}</Text>
              </View>
              <Text style={styles.threatTitle}>{ascii(threat.title || threat.component || 'Threat finding', 180)}</Text>
              <Text style={styles.threatMeta}>Review: {ascii(threat.reviewStatus || 'pending')}   ·   Applicability: {ascii((threat.disposition ?? 'applicable').replaceAll('_', ' '))}   ·   Evidence: {evidenceState(threat)}</Text>
              {threat.impact ? <><Text style={styles.bodyLabel}>Impact</Text><Text style={styles.body}>{ascii(threat.impact)}</Text></> : null}
              <View style={styles.mitigation}>
                <Text style={[styles.bodyLabel, { marginTop: 0, color: COLOR.charcoal }]}>Proposed mitigation</Text>
                <Text style={styles.body}>{ascii(threat.mitigation || 'No mitigation was generated.')}</Text>
                {threat.controlReference ? <Text style={[styles.evidenceMeta, { marginTop: 5, color: COLOR.green }]}>Control reference (verify definition and operation): {ascii(threat.controlReference, 180)}</Text> : null}
              </View>
              {threat.description ? <><Text style={styles.bodyLabel}>Scenario</Text><Text style={styles.body}>{ascii(threat.description)}</Text></> : null}
              <Text style={styles.threatFootnote}>Analysis: {ascii((threat.methodologies ?? [threat.methodology]).join(', '))}  ·  {threat.scoringStatus === 'unscored' ? 'Unscored' : `DREAD ${scoreLabel(threat)}`}. Detailed scoring and source evidence remain in the review workspace.</Text>
            </View>
          ))}
        </Page>
      ))}

      <Page size="A4" style={styles.page}>
        <Header logo={logo} label="Input Context" />
        <Footer runId={report.id} />
        <SectionLead title="Input Context" intro="Inferred architecture, supporting documents and the exact execution snapshot for this scan." />
        <Text style={styles.subheading}>Inferred context</Text>
        <View style={styles.summaryBox}><Text style={styles.summaryText}>{ascii(architecture?.systemDescription || report.systemDescription || 'No inferred context was stored.', 5000)}</Text></View>
        {architecture ? <><Text style={styles.subheading}>Recorded trust boundaries</Text><Text style={styles.body}>{ascii(architecture.trustBoundaries.join(', ') || 'No explicit trust boundaries were recorded.', 1500)}</Text></> : null}
        <Text style={styles.subheading}>Supporting documents</Text>
        <Text style={styles.body}>{report.inputBundle.supportingDocuments.length
          ? report.inputBundle.supportingDocuments.map((document) => `${ascii(document.name)} (${ascii(document.type)})`).join(', ')
          : 'No separate supporting documents were attached.'}</Text>
        <Text style={styles.subheading}>Execution snapshot</Text>
        {config ? (
          <View style={styles.twoCol}>
            <View style={styles.column}>
              <View style={styles.factRow}><Text style={styles.factLabel}>Provider</Text><Text style={styles.factValue}>{ascii(config.provider)}</Text></View>
              <View style={styles.factRow}><Text style={styles.factLabel}>Profile</Text><Text style={styles.factValue}>{ascii(config.executionProfile || 'local_efficient')}</Text></View>
              <View style={styles.factRow}><Text style={styles.factLabel}>Mode</Text><Text style={styles.factValue}>{ascii(config.executionMode)}</Text></View>
            </View>
            <View style={styles.column}>
              <View style={styles.factRow}><Text style={styles.factLabel}>Analysts</Text><Text style={styles.factValue}>{ascii(config.enabledAnalysts.join(', '))}</Text></View>
              <View style={styles.factRow}><Text style={styles.factLabel}>Quick model</Text><Text style={styles.factValue}>{ascii(config.quickModel || '-')}</Text></View>
              <View style={styles.factRow}><Text style={styles.factLabel}>Deep model</Text><Text style={styles.factValue}>{ascii(config.deepModel || '-')}</Text></View>
            </View>
          </View>
        ) : <Text style={styles.body}>Execution routing was not recorded for this earlier run.</Text>}
        <Text style={styles.subheading}>Provenance</Text>
        <View style={styles.factRow}><Text style={styles.factLabel}>Run ID</Text><Text style={styles.factValue}>{ascii(report.id)}</Text></View>
        <View style={styles.factRow}><Text style={styles.factLabel}>Version hash</Text><Text style={styles.factValue}>{ascii(report.inputBundle.versionHash)}</Text></View>
        <View style={styles.factRow}><Text style={styles.factLabel}>Created</Text><Text style={styles.factValue}>{reportDate(report.createdAt)}</Text></View>
        <View style={styles.factRow}><Text style={styles.factLabel}>Completed</Text><Text style={styles.factValue}>{reportDate(report.completedAt)}</Text></View>
      </Page>
    </Document>
  )
}

async function logoDataUri(): Promise<string> {
  const logoPath = join(process.cwd(), 'public', 'brand', 'argus-wordmark.svg')
  const source = await readFile(logoPath)
  const png = await sharp(source).resize({ width: 720 }).png().toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

export async function generatePhiloCyberPdf(report: PhiloCyberPdfReport): Promise<Buffer> {
  const logo = await logoDataUri()
  const buffer = await renderToBuffer(<ReportDocument report={report} logo={logo} />)
  return Buffer.from(buffer)
}
