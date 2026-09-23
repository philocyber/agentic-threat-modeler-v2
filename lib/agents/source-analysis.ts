import type { ArchitectureData, RawThreat } from '@/lib/models/types'
import { verifyArchitectureAnchors, formatSourceSections, packSourceSections, sourceCharacterBudget, sourceSectionsFit, type SourceSection } from '@/lib/architecture/source-evidence'
import { buildArchSummary } from './shared'
import { agentLog } from './logger'

/** Sequential complete-source passes keep local inference bounded. A failed pass fails coverage. */
export async function analyzeSourcePackets(
  architecture: ArchitectureData,
  models: unknown[],
  analyst: string,
  analyze: (packet: ArchitectureData) => Promise<RawThreat[]>,
): Promise<RawThreat[]> {
  const source = architecture.sourceEvidence
  if (!source) return analyze(architecture)
  source.analystDelivery ??= {}
  delete source.analystDelivery[analyst]
  const { packets, reconciliation } = planSourceAnalysis(architecture, models)
  const results: RawThreat[] = []
  const passes = [...packets, ...reconciliation]
  for (const [index, sections] of passes.entries()) {
    agentLog(`[${analyst}] Source pass ${index + 1}/${passes.length}: ${index < packets.length ? 'primary' : 'reconciliation'}, ${sections.length} original sections`)
    results.push(...await analyze({ ...architecture, sourceEvidence: { ...source, sections } }))
    agentLog(`[${analyst}] Source pass ${index + 1}/${passes.length} completed`)
  }
  source.analystDelivery ??= {}
  source.analystDelivery[analyst] = source.sections.map(s => s.id)
  return results.map(threat => verifyArchitectureAnchors(threat, source))
}

/** Pure planning: can be checked after extraction before any analyst starts. */
export function planSourceAnalysis(architecture: ArchitectureData, models: unknown[]) {
  const source = architecture.sourceEvidence
  if (!source) return { packets: [], reconciliation: [], budget: 0 }
  const base = buildArchSummary({ ...architecture, sourceEvidence: { ...source, sections: [] } }).length
  const budget = Math.min(...models.map(model => sourceCharacterBudget(model, base + 16_000)))
  if (source.sections.length && models.every(model => sourceSectionsFit(model, source.sections, base + 16_000))) {
    return { packets: [source.sections], reconciliation: [], budget: Math.max(budget, formatSourceSections(source.sections).length) }
  }
  const packets = packSourceSections(source.sections, budget)
  // Reconcile shared components across packets. If their complete context is too
  // large, pair bounded groups so every pair of related sections is delivered
  // together at least once, preserving original text and qualifications.
  const reconciliation: SourceSection[][] = []
  if (packets.length > 1) {
    const signatures = new Set<string>()
    let sharedGroups: SourceSection[][] | undefined
    const relationships = [
      ...architecture.components.map(c => [c.name]),
      ...architecture.dataFlows.map(flow => [flow.from, flow.to]),
    ]
    for (const names of relationships) {
      const related = source.sections.filter(s => names.some(name => s.text.toLowerCase().includes(name.toLowerCase())))
      const across = packets.filter(packet => packet.some(s => related.includes(s))).length > 1
      const key = related.map(s => s.id).join(',')
      if (!across || signatures.has(key)) continue
      if (formatSourceSections(related).length > budget) {
        sharedGroups ??= packSourceSections(source.sections, Math.floor((budget - 2) / 2))
      }
      const groups = formatSourceSections(related).length <= budget
        ? [related]
        : sharedGroups!.filter(group => group.some(section => related.includes(section)))
      const candidates = groups.length === 1 ? groups : groups.flatMap((left, i) =>
        groups.slice(i + 1).map(right => [...left, ...right]))
      for (const candidate of candidates) {
        const signature = candidate.map(s => s.id).join(',')
        if (signatures.has(signature)) continue
        signatures.add(signature)
        reconciliation.push(candidate)
      }
    }
  }
  // A larger scheduled pass already covers all relationships in its subsets.
  // Remove redundant passes without changing which source pairs are reviewed.
  const minimalReconciliation = reconciliation.filter((candidate, i) =>
    !packets.some(packet => candidate.every(section => packet.includes(section)))
    && !reconciliation.some((other, j) => i !== j && other.length > candidate.length
      && candidate.every(section => other.includes(section))))
  const pairs = (sections: SourceSection[]) => sections.flatMap((left, i) =>
    sections.slice(i).map(right => `${left.id}:${right.id}`))
  const covered = new Set(packets.flatMap(pairs))
  const remaining = [...minimalReconciliation]
  const scheduled: SourceSection[][] = []
  while (remaining.length) {
    // Greedy set cover: count the pairs not yet delivered, not just whether one
    // entire packet is a subset. Multiple earlier passes can cover a candidate.
    const ranked = remaining.map((sections, index) => ({
      sections, index, pairs: pairs(sections).filter(pair => !covered.has(pair)),
    })).sort((a, b) => b.pairs.length - a.pairs.length || a.index - b.index)
    const next = ranked[0]!
    if (!next.pairs.length) break
    scheduled.push(next.sections)
    next.pairs.forEach(pair => covered.add(pair))
    remaining.splice(next.index, 1)
  }
  return { packets, reconciliation: scheduled, budget }
}
