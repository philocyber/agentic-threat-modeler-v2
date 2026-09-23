import { severityLabel } from '@/lib/models/scoring'
import type { UnifiedThreat, ArchitectureData } from '@/lib/models/types'
import { escapeCsvCell } from '@/lib/utils/csv'
import { buildArchitectureMermaid, buildArchitectureReferences, type DiagramThreat } from '@/lib/architecture/mermaid'
import { buildThreatDisplayIdMap } from '@/lib/models/threat-display-id'
import { formatStoredDebateSummary } from '@/lib/agents/debate-format'
import { describeRunExecution } from '@/lib/reports/execution-status'

// ─── CSV generation ───────────────────────────────────────────────────────────

const CSV_HEADERS = [
  'ID Amenaza',
  'Componente',
  'Patrón de Amenaza',
  'Descripción',
  'Categoría STRIDE',
  'Categorías OWASP',
  'Control de Amenaza',
  'Damage',
  'Reproducibility',
  'Exploitability',
  'Affected Users',
  'Discoverability',
  'Puntaje DREAD',
  'Prioridad',
  'Estado',
  'Trazabilidad',
]

function escapeCsvField(value: string): string {
  return escapeCsvCell(value)
}

function architectureReferenceMarkdown(architecture: ArchitectureData, threats: DiagramThreat[]): string {
  const references = buildArchitectureReferences(architecture, threats)
  if (!references.length) return ''
  const threatRows = references.filter((reference) => reference.kind === 'threat')
    .map((reference) => `| ${reference.id} | ${reference.component} | ${reference.label} |`).join('\n')
  const controlRows = references.filter((reference) => reference.kind === 'control')
    .map((reference) => `| ${reference.id}${reference.sourceControlId ? ` (${reference.sourceControlId})` : ''} | ${reference.linkedThreatId ?? '-'} | ${reference.component} | ${reference.label} |`).join('\n')
  return `${threatRows ? `\n\n### Threat references\n\n| ID | Component | Finding |\n|---|---|---|\n${threatRows}` : ''}${controlRows ? `\n\n### Threat to control mapping\n\n| Control | Threat | Component | Recommendation |\n|---|---|---|---|\n${controlRows}` : ''}`
}

export function generateCSV(threats: UnifiedThreat[]): string {
  const rows = threats.map((t) => {
    const id = t.displayId || t.id || 'UNKNOWN'

    const reviewLabel =
      t.reviewStatus === 'confirmed'
        ? 'Confirmado'
        : t.reviewStatus === 'rejected'
          ? 'Rechazado'
          : 'Pendiente'

    // Build traceability string
    const traceabilityParts = []
    if (t.traceability?.components?.length) traceabilityParts.push(`Components: ${t.traceability.components.join(', ')}`)
    if (t.traceability?.endpoints?.length) traceabilityParts.push(`Endpoints: ${t.traceability.endpoints.join(', ')}`)
    if (t.traceability?.trustBoundaries?.length) traceabilityParts.push(`Trust Boundaries: ${t.traceability.trustBoundaries.join(', ')}`)
    if (t.traceability?.securityConfigs?.length) traceabilityParts.push(`Security Configs: ${t.traceability.securityConfigs.join(', ')}`)
    const traceabilityStr = traceabilityParts.join(' | ')

    return [
      id,
      t.component,
      t.title || t.description.slice(0, 80),
      t.description.replace(/\n/g, ' '),
      t.strideCategory ?? '-',
      (t.owaspCategories ?? []).join('; ') || '-',
      t.mitigation.replace(/\n/g, ' '),
      t.scoringStatus === 'unscored' ? '' : t.dread.damage.toString().replace('.', ','),
      t.scoringStatus === 'unscored' ? '' : t.dread.reproducibility.toString().replace('.', ','),
      t.scoringStatus === 'unscored' ? '' : t.dread.exploitability.toString().replace('.', ','),
      t.scoringStatus === 'unscored' ? '' : t.dread.affectedUsers.toString().replace('.', ','),
      t.scoringStatus === 'unscored' ? '' : t.dread.discoverability.toString().replace('.', ','),
      t.scoringStatus === 'unscored' ? '' : t.dread.total.toString().replace('.', ','),
      severityLabel(t).toUpperCase(),
      reviewLabel,
      traceabilityStr || '-',
    ].map(escapeCsvField)
  })

  return [CSV_HEADERS.map(escapeCsvField).join(','), ...rows.map((r) => r.join(','))].join('\n')
}

// ─── Dynamic markdown generation from DB ──────────────────────────────────────

export function generateMarkdownFromDB(params: {
  threatModel: {
    id: string
    title: string | null
    systemDescription: string | null
    createdAt: Date
    methodologiesUsed: unknown
    debateSummary: string | null
    architectureJson: unknown
    status?: string | null
    errorMessage?: string | null
    pipelineErrors?: unknown
  }
  threats: Array<{
    id: string
    title: string
    component: string | null
    description: string
    impact: string | null
    mitigation: string | null
    strideCategory: string | null
    owaspCategories: unknown
    controlReference: string | null
    dreadDamage: number | null
    dreadReproducibility: number | null
    dreadExploitability: number | null
    dreadAffectedUsers: number | null
    dreadDiscoverability: number | null
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null
    traceability: unknown
    evidenceSources: unknown
    userComments: string | null
    reviewStatus: string | null
  }>
}): string {
  const { threatModel, threats } = params
  const date = threatModel.createdAt.toISOString().split('T')[0]
  
  const criticalCount = threats.filter(t => t.severity === 'CRITICAL').length
  const highCount = threats.filter(t => t.severity === 'HIGH').length
  const mediumCount = threats.filter(t => t.severity === 'MEDIUM').length
  const lowCount = threats.filter(t => t.severity === 'LOW').length

  const methodologies = (threatModel.methodologiesUsed as string[] | null) ?? []
  const arch = threatModel.architectureJson as ArchitectureData | null
  const displayIds = buildThreatDisplayIdMap(threats)
  const diagramThreats: DiagramThreat[] = threats.map((threat) => ({
    id: threat.id,
    displayId: displayIds.get(threat.id),
    title: threat.title,
    component: threat.component,
    mitigation: threat.mitigation,
    controlReference: threat.controlReference,
    traceability: threat.traceability as { components?: string[] } | null,
  }))

  const execution = describeRunExecution({
    status: threatModel.status,
    errorMessage: threatModel.errorMessage,
    pipelineErrors: Array.isArray(threatModel.pipelineErrors) ? threatModel.pipelineErrors as string[] : null,
    threatCount: threats.length,
  })

  return `# Threat Model: ${threatModel.title ?? threatModel.id}

**Date:** ${date}
**Methodology:** ${methodologies.join(' + ') || 'Not specified'}
**Execution:** ${execution.kind}
**${execution.kind === 'failed' && threats.length === 0 ? 'Findings' : 'Total Threats'}:** ${execution.kind === 'failed' && threats.length === 0 ? 'not produced (run failed)' : threats.length}

---

## Executive Summary

${execution.detail}

${execution.kind === 'completed' && threats.length > 0 ? `Analysis identified **${threats.length} threats**${arch ? ` across ${arch.components.length} components` : ''}:` : ''}

- 🔴 Critical: ${criticalCount}
- 🟠 High: ${highCount}
- 🟡 Medium: ${mediumCount}
- 🟢 Low: ${lowCount}

**System:** ${threatModel.systemDescription || 'No description provided'}

---

${arch && (arch.components?.length || arch.dataFlows?.length || arch.externalEntities?.length) ? `## Data Flow Diagram

\`\`\`mermaid
${buildArchitectureMermaid(arch, diagramThreats)}
\`\`\`
${architectureReferenceMarkdown(arch, diagramThreats)}

---

` : ''}## Threat Summary

| ID | Component | Threat Pattern | DREAD | Priority |
|---|---|---|---|---|
${threats.map(t => {
  const dreadAvg = ((t.dreadDamage ?? 0) + (t.dreadReproducibility ?? 0) + (t.dreadExploitability ?? 0) + (t.dreadAffectedUsers ?? 0) + (t.dreadDiscoverability ?? 0)) / 5
  return `| ${displayIds.get(t.id)} | ${t.component || 'Unknown'} | ${t.title || t.description.slice(0, 60)} | ${[t.dreadDamage, t.dreadReproducibility, t.dreadExploitability, t.dreadAffectedUsers, t.dreadDiscoverability].some(n => n == null) ? 'Unscored' : dreadAvg.toFixed(1)} | ${t.severity ?? 'UNSCORED'} |`
}).join('\n')}

---

## Detailed Threats

${threats.map(t => {
  const dreadAvg = ((t.dreadDamage ?? 0) + (t.dreadReproducibility ?? 0) + (t.dreadExploitability ?? 0) + (t.dreadAffectedUsers ?? 0) + (t.dreadDiscoverability ?? 0)) / 5
  const owaspCats = (t.owaspCategories as string[] | null) ?? []
  const traceability = (t.traceability as {
    trustBoundaries?: string[]
    components?: string[]
    endpoints?: string[]
    environmentVars?: string[]
    securityConfigs?: string[]
  } | null) ?? {}
  const evidenceSrcs = (t.evidenceSources as Array<{sourceType: string, sourceName: string, excerpt: string}> | null) ?? []

  return `### ${displayIds.get(t.id)} - ${t.title || t.component || 'Unknown'}

**Component:** ${t.component || 'Unknown'}  
**Priority:** ${t.severity ?? 'UNSCORED'}  
**DREAD:** ${[t.dreadDamage, t.dreadReproducibility, t.dreadExploitability, t.dreadAffectedUsers, t.dreadDiscoverability].some(n => n == null) ? 'Unscored' : dreadAvg.toFixed(1)} (D:${t.dreadDamage} R:${t.dreadReproducibility} E:${t.dreadExploitability} A:${t.dreadAffectedUsers} Disc:${t.dreadDiscoverability})  
${t.strideCategory ? `**STRIDE Category:** ${t.strideCategory}  \n` : ''}${owaspCats.length > 0 ? `**OWASP:** ${owaspCats.join(', ')}  \n` : ''}${t.controlReference ? `**Control Reference:** ${t.controlReference}  \n` : ''}
**Description:**
${t.description}

**Impact:**
${t.impact || 'Not specified'}

**Mitigation:**
${t.mitigation || 'Not specified'}
${(traceability.trustBoundaries?.length || traceability.components?.length || traceability.endpoints?.length || traceability.environmentVars?.length || traceability.securityConfigs?.length) ? `
**Traceability:**
${traceability.trustBoundaries?.length ? `- **Trust Boundaries:** ${traceability.trustBoundaries.join(', ')}\n` : ''}${traceability.components?.length ? `- **Components:** ${traceability.components.join(', ')}\n` : ''}${traceability.endpoints?.length ? `- **Endpoints:** ${traceability.endpoints.join(', ')}\n` : ''}${traceability.environmentVars?.length ? `- **Environment Variables:** ${traceability.environmentVars.join(', ')}\n` : ''}${traceability.securityConfigs?.length ? `- **Security Configurations:** ${traceability.securityConfigs.join(', ')}\n` : ''}` : ''}${evidenceSrcs.length > 0 ? `\n**Evidence Sources (Deprecated):**  \n${evidenceSrcs.map(e => `- ${e.sourceType}: "${e.excerpt.slice(0, 100)}"`).join('\n')}\n` : ''}${t.userComments ? `\n**User Comments:**\n${t.userComments}\n` : ''}${t.reviewStatus && t.reviewStatus !== 'pending' ? `\n**Review Status:** ${t.reviewStatus}` : ''}`
}).join('\n\n---\n\n')}

${threatModel.debateSummary ? `
---

## Red Team / Blue Team Debate

${formatStoredDebateSummary(threatModel.debateSummary, threats.map((threat) => ({
  id: threat.id,
  displayId: displayIds.get(threat.id),
  title: threat.title,
  component: threat.component,
  description: threat.description,
  severity: threat.severity,
})))}
` : ''}${arch ? `
---

## Architecture Details

**Components (${arch.components.length}):**

${arch.components.map(c => `- **${c.name}** (${c.type}, ${c.scope}${c.technology ? ', ' + c.technology : ''})`).join('\n')}

**Data Flows:**

${arch.dataFlows.map(f => `- ${f.from} → ${f.to}: ${f.data}${f.protocol ? ' (' + f.protocol + ')' : ''}`).join('\n')}

${arch.trustBoundaries?.length ? `\n**Trust Boundaries:** ${arch.trustBoundaries.join(', ')}` : ''}
` : ''}`
}
