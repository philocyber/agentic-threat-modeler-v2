import { makePassage, type EvidencePassage } from './evidence'
import type { ArchitectureData } from '@/lib/db/schema'

export type RAGRetrievalPlan = {
  system?: string | undefined
  technologies: string[]
  components: string[]
  trustBoundaries: string[]
  controls: string[]
  assets: string[]
  queryHints: string[]
}

type RAGTraceSource = {
  id: string
  domain: 'technical' | 'corporate' | 'reviewer'
  source: string
  rank: number
  fusionScore: number
  distance?: number
  retrieval?: string
  passage?: EvidencePassage | undefined
  characters: number
}

export type RAGTraceEntry = {
  id: string
  profile: string
  originalQuery: string
  routedQuery: string
  queryVariants?: string[] | undefined
  startedAt: string
  durationMs: number
  budgetCharacters: number
  selectedCharacters: number
  selected: RAGTraceSource[]
  discardedCount: number
  cacheHits: number
  rejected?: Record<string, number> | undefined
}

export type RAGTraceSnapshot = {
  version: 1 | 2
  plan: RAGRetrievalPlan | null
  entries: RAGTraceEntry[]
  candidateOutcomes?: Array<{ candidateId: string; outcome: 'represented' | 'not_retained'; findingIds: string[] }> | undefined
  totals: {
    queries: number
    sourcesSelected: number
    charactersSelected: number
    cacheHits: number
    durationMs: number
  }
}

export function buildRAGRetrievalPlan(architecture: ArchitectureData): RAGRetrievalPlan {
  const technologies = [...new Set(architecture.components.flatMap((component) => component.technology ? [component.technology] : []))]
  const controls = (architecture.factLedger?.controls ?? []).map((control) => `${control.name}:${control.status}`)
  const assets = architecture.factLedger?.assets ?? architecture.dataStores
  return {
    technologies: technologies.slice(0, 12),
    components: architecture.components.map((component) => `${component.name}:${component.type}`).slice(0, 16),
    trustBoundaries: architecture.trustBoundaries.slice(0, 10),
    controls: controls.slice(0, 12),
    assets: assets.slice(0, 12),
    queryHints: [...new Set([
      ...technologies,
      ...architecture.components.map((component) => component.type),
      ...architecture.techFlags.hasAI ? ['LLM AI agentic security'] : [],
      ...architecture.techFlags.hasAuthSystem ? ['authentication authorization session'] : [],
      ...architecture.techFlags.hasExternalIntegrations ? ['third-party integration trust boundary'] : [],
    ])].slice(0, 16),
  }
}

function safeSource(source: string): string {
  const normalized = source.replace(/\\/g, '/')
  const knowledgeIndex = normalized.toLowerCase().lastIndexOf('/knowledge_base/')
  return knowledgeIndex >= 0 ? normalized.slice(knowledgeIndex + '/knowledge_base/'.length) : normalized.slice(-240)
}

export class RAGTraceCollector {
  private plan: RAGRetrievalPlan | null = null
  private entries: RAGTraceEntry[] = []
  private candidateOutcomes: NonNullable<RAGTraceSnapshot['candidateOutcomes']> = []

  restore(snapshot: RAGTraceSnapshot): void {
    if (snapshot.version !== 2) return
    const known = new Set(this.entries.map(entry => entry.id))
    for (const entry of snapshot.entries) {
      if (known.has(entry.id)) continue
      const selected = entry.selected.filter(source => {
        const p = source.passage
        return p && makePassage({ id: p.chunkId, domain: p.domain, source: p.source, document: p.excerpt, metadata: { ...p.metadata, sha256: p.version } }, p.queryId).citationId === p.citationId
      })
      this.record({ ...entry, selected })
      known.add(entry.id)
    }
    if (!this.plan) this.plan = snapshot.plan
  }

  getPassages(): EvidencePassage[] {
    return [...new Map(this.entries.flatMap(entry => entry.selected.flatMap(source => source.passage ? [source.passage] : [])).map(p => [p.citationId, p])).values()]
  }

  recordCandidateOutcomes(candidates: Array<{ candidateId?: string | undefined }>, findings: Array<{ id: string; sourceCandidateIds?: string[] | undefined }>): void {
    this.candidateOutcomes = candidates.flatMap(candidate => {
      if (!candidate.candidateId) return []
      const findingIds = findings.filter(f => f.sourceCandidateIds?.includes(candidate.candidateId!)).map(f => f.id)
      return [{ candidateId: candidate.candidateId, outcome: findingIds.length ? 'represented' as const : 'not_retained' as const, findingIds }]
    })
  }

  setPlan(plan: RAGRetrievalPlan): void {
    this.plan = plan
  }

  getPlan(): RAGRetrievalPlan | null {
    return this.plan
  }

  record(entry: RAGTraceEntry): void {
    this.entries.push({
      ...entry,
      selected: entry.selected.map((source) => ({ ...source, source: safeSource(source.source) })),
    })
  }

  snapshot(): RAGTraceSnapshot {
    return {
      version: 2,
      plan: this.plan,
      entries: [...this.entries],
      candidateOutcomes: this.candidateOutcomes,
      totals: {
        queries: this.entries.length,
        sourcesSelected: this.entries.reduce((sum, entry) => sum + entry.selected.length, 0),
        charactersSelected: this.entries.reduce((sum, entry) => sum + entry.selectedCharacters, 0),
        cacheHits: this.entries.reduce((sum, entry) => sum + entry.cacheHits, 0),
        durationMs: this.entries.reduce((sum, entry) => sum + entry.durationMs, 0),
      },
    }
  }
}
