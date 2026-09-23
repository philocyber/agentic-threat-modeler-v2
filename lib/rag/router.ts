import { createHash } from 'node:crypto'
import type { CorporateRAGStore } from './corporate-store'
import { searchGlobalCorpus } from './global-corpus'
import type { RAGResult, RAGStoreManager, TechnicalCollectionName } from './store'
import { searchReviewedThreatKnowledge } from '@/lib/storage/review-learning'
import type { RAGRetrievalPlan } from './trace'
import { RAGTraceCollector } from './trace'
import { RAG_PASSAGE_MAX_CHARACTERS, RAG_MAX_QUERIES_PER_RUN } from './constants'
import { makePassage, formatPassages, type EvidencePack, type EvidencePassage } from './evidence'
import { rankSections, scopeMismatch, type EvidenceScope } from './ranking'

export type RAGDomain = 'technical' | 'corporate' | 'reviewer'
export type RAGProfile = 'analyst' | 'red_team' | 'blue_team' | 'synthesis' | 'validator'

export type RAGQueryRequest = EvidenceScope & {
  purpose?: 'mechanism' | 'control' | 'impact' | 'verification' | undefined
  /** The step's concrete retrieval objective, rather than a generic role label. */
  query: string
  /** Components, flows, controls, or threat candidates the evidence must address. */
  facets?: string[] | undefined
}

export type RAGEvidence = {
  id: string
  domain: RAGDomain
  source: string
  document: string
  metadata: Record<string, unknown>
  rank: number
  fusionScore: number
}

type RAGPolicy = {
  quotas: Record<RAGDomain, number>
  weights: Record<RAGDomain, number>
  technicalCollections: TechnicalCollectionName[]
}

const RAG_CONTEXT_BUDGETS: Record<RAGProfile, number> = {
  analyst: 9_000,
  red_team: 8_000,
  blue_team: 8_000,
  synthesis: 10_000,
  validator: 6_500,
}

export const RAG_POLICIES: Record<RAGProfile, RAGPolicy> = {
  analyst: {
    quotas: { technical: 6, corporate: 4, reviewer: 2 },
    weights: { technical: 1, corporate: 0.9, reviewer: 0.6 },
    technicalCollections: ['technical', 'books', 'research', 'risks', 'aiThreats'],
  },
  red_team: {
    quotas: { technical: 7, corporate: 3, reviewer: 1 },
    weights: { technical: 1.15, corporate: 0.75, reviewer: 0.6 },
    technicalCollections: ['technical', 'research', 'risks', 'books', 'aiThreats'],
  },
  blue_team: {
    quotas: { technical: 4, corporate: 6, reviewer: 3 },
    weights: { technical: 0.85, corporate: 1.1, reviewer: 0.6 },
    technicalCollections: ['technical', 'risks', 'books', 'research', 'aiThreats'],
  },
  synthesis: {
    quotas: { technical: 4, corporate: 6, reviewer: 4 },
    weights: { technical: 0.9, corporate: 1.05, reviewer: 0.6 },
    technicalCollections: ['technical', 'risks', 'research', 'books', 'aiThreats'],
  },
  validator: {
    quotas: { technical: 6, corporate: 4, reviewer: 3 },
    weights: { technical: 1.1, corporate: 0.9, reviewer: 0.6 },
    technicalCollections: ['technical', 'risks', 'books', 'research', 'aiThreats'],
  },
}

function evidenceKey(item: Pick<RAGEvidence, 'source' | 'document'>): string {
  return createHash('sha256')
    .update(`${item.source}\n${item.document.trim().toLowerCase()}`)
    .digest('hex')
}

export function fuseEvidence(
  groups: Record<RAGDomain, Array<Omit<RAGEvidence, 'rank' | 'fusionScore'>>>,
  policy: Pick<RAGPolicy, 'quotas' | 'weights'>,
): RAGEvidence[] {
  const deduped = new Map<string, RAGEvidence>()
  for (const domain of ['technical', 'corporate', 'reviewer'] as const) {
    let accepted = 0
    const seen = new Set<string>()
    const sourceCounts = new Map<string, number>()
    groups[domain].forEach((item, index) => {
      const key = evidenceKey(item)
      if (seen.has(key) || (sourceCounts.get(item.source) ?? 0) >= 2 || accepted >= policy.quotas[domain]) return
      seen.add(key)
      sourceCounts.set(item.source, (sourceCounts.get(item.source) ?? 0) + 1)
      accepted++
      const evidence: RAGEvidence = {
        ...item,
        rank: index + 1,
        fusionScore: policy.weights[domain] / (60 + index + 1),
      }
      const existing = deduped.get(key)
      if (!existing || evidence.fusionScore > existing.fusionScore) deduped.set(key, evidence)
    })
  }
  return [...deduped.values()].sort((left, right) =>
    right.fusionScore - left.fusionScore || left.domain.localeCompare(right.domain),
  )
}

function interleave<T>(groups: T[][]): T[] {
  const output: T[] = []
  const max = Math.max(0, ...groups.map((group) => group.length))
  for (let index = 0; index < max; index += 1) {
    for (const group of groups) {
      const item = group[index]
      if (item) output.push(item)
    }
  }
  return output
}

/** Merge query variants so evidence supported by several formulations wins. */
export function reciprocalRankMerge<
  T extends Pick<RAGEvidence, 'id' | 'domain' | 'source' | 'document' | 'metadata'>,
>(groups: T[][]): T[] {
  const merged = new Map<string, { item: T; score: number; matches: number }>()
  for (const group of groups) {
    group.forEach((item, index) => {
      const key = `${item.domain}:${item.id || evidenceKey(item)}`
      const existing = merged.get(key)
      const score = 1 / (60 + index + 1)
      if (existing) {
        existing.score += score
        existing.matches += 1
      } else {
        merged.set(key, { item, score, matches: 1 })
      }
    })
  }
  return [...merged.values()]
    .sort((left, right) => right.score - left.score || right.matches - left.matches)
    .map(({ item, score, matches }) => ({
      ...item,
      metadata: { ...item.metadata, queryFusionScore: score, queryMatches: matches },
    }))
}

function vectorEvidence(
  domain: 'technical' | 'corporate',
  result: RAGResult,
): Omit<RAGEvidence, 'rank' | 'fusionScore'> {
  return {
    id: result.id,
    domain,
    source: String(result.metadata.source ?? result.source),
    document: result.document,
    metadata: { ...result.metadata, retrieval: result.metadata.retrieval ?? 'vector', distance: result.distance } as Record<string, unknown>,
  }
}

function renderedCharacters(item: RAGEvidence): number {
  return formatPassages([makePassage(item, 'budget')]).length + 2
}

export function applyContextBudget(evidence: RAGEvidence[], budget: number): RAGEvidence[] {
  const selected: RAGEvidence[] = []
  const perSource = new Map<string, number>()
  let used = 0
  for (const item of evidence) {
    const sourceCount = perSource.get(item.source) ?? 0
    if (sourceCount >= 2) continue
    const projected = used + renderedCharacters(item)
    if (projected > budget) continue
    selected.push(item)
    perSource.set(item.source, sourceCount + 1)
    used = projected
  }
  return selected
}

function planHints(plan: RAGRetrievalPlan | null): string {
  if (!plan) return ''
  return interleave([plan.technologies.slice(0, 4), plan.controls.slice(0, 4), plan.assets.slice(0, 4), plan.queryHints.slice(0, 2)])
    .slice(0, 14)
    .join(' ')
    .slice(0, 450)
}

function compactFacet(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function buildQueryVariants(
  request: RAGQueryRequest,
  plan: RAGRetrievalPlan | null,
): string[] {
  const objective = request.query.replace(/\s+/g, ' ').trim().slice(0, 1000)
  const facets = [...new Set((request.facets ?? []).map(compactFacet).filter(Boolean))].slice(0, 8)
  const hints = planHints(plan)
  const variants = [
    `${objective}\nScope: ${request.system ?? ''} ${request.environment ?? ''}${hints ? `\nArchitecture: ${hints}` : ''}`,
    facets.length > 0 ? `${objective}\nFocus evidence: ${facets.join(' | ')}` : '',
  ]
  return [...new Set(variants.map((variant) => variant.trim().slice(0, 1800)).filter(Boolean))].slice(0, 2)
}

export class DualRAGRouter {
  private plan: RAGRetrievalPlan | null = null
  private queries = 0
  private registry = new Map<string, EvidencePassage>()
  getPassages(): EvidencePassage[] { return [...this.registry.values()] }
  async queryPack(request: RAGQueryRequest, profile: RAGProfile): Promise<EvidencePack> {
    const queryId = `rag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const exhausted = this.queries >= RAG_MAX_QUERIES_PER_RUN
    const evidence = await this.query(request, profile, queryId)
    const passages = evidence.map(item => makePassage(item, queryId))
    for (const passage of passages) this.registry.set(passage.citationId, passage)
    return { version: 2, queryId, question: request.query, status: exhausted ? 'budget_exhausted' : passages.length ? 'retrieved' : 'no_evidence', passages }
  }

  constructor(
    private readonly technical: RAGStoreManager,
    private readonly corporate: CorporateRAGStore | null,
    private readonly trace?: RAGTraceCollector,
    private readonly knowledgeBasePath?: string,
    private readonly systemId?: string | null,
    private readonly currentRunId?: string,
  ) {
    this.plan = trace?.getPlan() ?? null
    this.queries = trace?.snapshot().totals.queries ?? 0
    for (const passage of trace?.getPassages() ?? []) this.registry.set(passage.citationId, passage)
  }

  setPlan(plan: RAGRetrievalPlan): void {
    this.plan = plan
    this.trace?.setPlan(plan)
  }

  async query(queryInput: string | RAGQueryRequest, profile: RAGProfile, queryId = `rag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`): Promise<RAGEvidence[]> {
    const started = Date.now()
    const request: RAGQueryRequest = { system: this.plan?.system, ...(typeof queryInput === 'string' ? { query: queryInput } : queryInput) }
    const originalQuery = request.query.trim().slice(0, 1000)
    if (this.queries >= RAG_MAX_QUERIES_PER_RUN) return []
    this.queries++
    if (!originalQuery) return []
    const queryVariants = buildQueryVariants(request, this.plan)
    const policy = RAG_POLICIES[profile]
    const technicalCandidateTarget = Math.max(policy.quotas.technical * 3, this.technical.getConfiguredTopK())
    const technicalPerCollection = Math.max(
      2,
      Math.ceil(technicalCandidateTarget / policy.technicalCollections.length),
    )

    let cacheHits = 0
    const [technicalByQuery, treeByQuery, corporateVectorByQuery, corporateLexicalByQuery, reviewerByQuery] = await Promise.all([
      Promise.all(queryVariants.map((query) => Promise.all(policy.technicalCollections.map(async (collection) => {
        const [results, direct] = await Promise.all([this.technical.hierarchicalQuery(collection, query, technicalPerCollection), this.technical.query(collection, query, 2)])
        cacheHits += results.cacheHits
        return [...new Map([...results.results, ...direct].map(item => [item.id, item])).values()].map((result) => vectorEvidence('technical', result))
      })))),
      Promise.all(queryVariants.map(async (query) => (await this.technical.treeQuery(query, 3)).map((hit) => ({
        id: `tree:${hit.docName}:${hit.sectionPath}`,
        domain: 'technical' as const,
        source: hit.docName,
        document: hit.text,
        metadata: {
          retrieval: 'tree',
          sectionPath: hit.sectionPath,
          pageRange: hit.pageRange ?? '',
          score: hit.score,
        },
      })))),
      Promise.all(queryVariants.map((query) => this.corporate?.query(query, Math.min(30, policy.quotas.corporate * 3), request) ?? Promise.resolve([]))),
      Promise.all(queryVariants.map((query) => searchGlobalCorpus('corporate', query, policy.quotas.corporate * 3, this.knowledgeBasePath, request))),
      this.systemId
        ? Promise.all(queryVariants.map((query) => searchReviewedThreatKnowledge(query, this.systemId!, policy.quotas.reviewer, this.currentRunId)))
        : Promise.resolve(queryVariants.map(() => [])),
    ])

    const technical = reciprocalRankMerge(queryVariants.map((_, queryIndex) => interleave([
      ...(technicalByQuery[queryIndex] ?? []),
      treeByQuery[queryIndex] ?? [],
    ])))
    const corporate = reciprocalRankMerge(queryVariants.map((_, queryIndex) => interleave([
      (corporateVectorByQuery[queryIndex] ?? []).map((result) => vectorEvidence('corporate', result)),
      (corporateLexicalByQuery[queryIndex] ?? []).map((hit) => ({
        id: hit.id,
        domain: 'corporate' as const,
        source: hit.path,
        document: hit.excerpt,
        metadata: { ...hit.metadata, source: hit.path, retrieval: 'bm25', score: hit.score },
      })),
    ])))
    const reviewed = reciprocalRankMerge(reviewerByQuery.map((reviewer) => reviewer.map((example) => ({
      id: example.id,
      domain: 'reviewer' as const,
      source: `review:${example.id}`,
      document: [
        `${example.reviewStatus.toUpperCase()}: ${example.title}`,
        `Component: ${example.component ?? 'not specified'}`,
        example.description,
        example.reviewNotes ? `Reviewer rationale: ${example.reviewNotes}` : '',
      ].filter(Boolean).join('\n'),
      metadata: {
        reviewStatus: example.reviewStatus,
        sourceRunId: example.sourceRunId,
        reviewedAt: example.reviewedAt?.toISOString() ?? '',
        qualification: 'Historical reviewer decision for this system; not current architecture evidence or an automatic verdict.',
        component: example.component ?? '',
        strideCategory: example.strideCategory ?? '',
      },
    }))))

    const rejected: Record<string, number> = {}
    const rerank = (items: Array<Omit<RAGEvidence, 'rank' | 'fusionScore'>>) => {
      const eligible = items.filter(item => {
        const reason = scopeMismatch(item.metadata, request)
          ?? (item.metadata.doc_type === 'playbook' && !/\b(rag|retrieval|indexing|embedding)\b/i.test(originalQuery) ? 'unrelated_playbook' : null)
        if (reason) { rejected[reason] = (rejected[reason] ?? 0) + 1; return false }
        return true
      })
      return rankSections(eligible, `${originalQuery} ${(request.facets ?? []).join(' ')}`, item => `${item.metadata.sectionPath ?? ''} ${item.document}`)
        .filter(hit => {
          if (hit.score > 0) return true
          rejected.no_question_overlap = (rejected.no_question_overlap ?? 0) + 1
          return false
        }).map(({ item, score }) => ({ ...item, metadata: { ...item.metadata, relevanceScore: score } }))
    }
    const fused = fuseEvidence({ technical: rerank(technical), corporate: rerank(corporate), reviewer: rerank(reviewed) }, policy)
    const budgetCharacters = RAG_CONTEXT_BUDGETS[profile]
    const selected = applyContextBudget(fused.map(item => ({ ...item, document: selectPassageWindow(item.document, originalQuery) })), budgetCharacters)
    this.trace?.record({
      id: queryId,
      rejected,
      profile,
      originalQuery,
      routedQuery: queryVariants[0] ?? originalQuery,
      queryVariants,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      budgetCharacters,
      selectedCharacters: selected.reduce((sum, item) => sum + renderedCharacters(item), 0),
      selected: selected.map((item) => ({
        id: item.id,
        domain: item.domain,
        source: item.source,
        rank: item.rank,
        fusionScore: item.fusionScore,
        ...(typeof item.metadata.distance === 'number' ? { distance: item.metadata.distance } : {}),
        ...(typeof item.metadata.retrieval === 'string' ? { retrieval: item.metadata.retrieval } : {}),
        characters: item.document.length,
        passage: makePassage(item, queryId),
      })),
      discardedCount: Math.max(0, technical.length + corporate.length + reviewed.length - selected.length),
      cacheHits,
    })
    return selected
  }
}

export function formatEvidencePack(evidence: RAGEvidence[]): string {
  return evidence.length ? formatPassages(evidence.map(item => makePassage(item, 'preview'))) : 'No relevant RAG evidence found.'
}

/** Select a relevant paragraph window for long legacy/tree passages; preserve full new chunks. */
export function selectPassageWindow(document: string, question: string): string {
  if (document.length <= RAG_PASSAGE_MAX_CHARACTERS) return document
  const paragraphs = document.split(/\n\s*\n/)
  const best = rankSections(paragraphs, question, p => p)[0]?.item ?? paragraphs[0] ?? ''
  const at = document.indexOf(best)
  const start = Math.max(0, at - 300)
  return document.slice(start, start + RAG_PASSAGE_MAX_CHARACTERS)
}
