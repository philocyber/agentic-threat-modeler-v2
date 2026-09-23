import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { tokenizeSecurityText } from './tokenize'

// ─── Types (compatible with Python page_indices/*.json) ───────────────────────

type PageIndexNode = {
  title: string
  page_start?: number
  page_end?: number
  text?: string
  summary?: string
  children?: PageIndexNode[]
}

export type PageIndex = {
  document_name: string
  document_path: string
  nodes: PageIndexNode[]
}

export type TreeRetrievalResult = {
  docName: string
  sectionPath: string
  pageRange?: string | undefined
  text: string
  relevanceNote: string
  score: number
}

export type PageIndexInspection = {
  fileCount: number
  documentCount: number
  nodeCount: number
  error?: string
}

// ─── Load indices ─────────────────────────────────────────────────────────────

const _indexCache = new Map<string, PageIndex>()
const _indexWarnings = new Map<string, string[]>()

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeNode(raw: unknown): PageIndexNode | null {
  if (!raw || typeof raw !== 'object') return null
  const node = raw as Record<string, unknown>
  const childrenRaw = node.children
  const children = Array.isArray(childrenRaw)
    ? childrenRaw.map(normalizeNode).filter((child): child is PageIndexNode => child !== null)
    : undefined
  const page_start = optionalNumber(node.page_start ?? node.start_page)
  const page_end = optionalNumber(node.page_end ?? node.end_page)
  const text = optionalString(node.text)
  const summary = optionalString(node.summary)
  return {
    title: typeof node.title === 'string' ? node.title : '',
    ...(page_start !== undefined ? { page_start } : {}),
    ...(page_end !== undefined ? { page_end } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(children && children.length > 0 ? { children } : {}),
  }
}

export function normalizePageIndex(raw: unknown, fallbackName = 'document'): PageIndex {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const nodesRaw = rec.nodes ?? rec.tree
  const nodes = Array.isArray(nodesRaw)
    ? nodesRaw.map(normalizeNode).filter((node): node is PageIndexNode => node !== null)
    : []
  return {
    document_name: optionalString(rec.document_name) ?? optionalString(rec.doc_name) ?? fallbackName,
    document_path: optionalString(rec.document_path) ?? optionalString(rec.doc_path) ?? '',
    nodes,
  }
}

export function clearPageIndexCache(): void {
  _indexCache.clear()
  _indexWarnings.clear()
}

export function loadPageIndices(indicesDir: string): PageIndex[] {
  if (!existsSync(indicesDir)) return []

  const warnings: string[] = []
  const indices = readdirSync(indicesDir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const filePath = path.join(indicesDir, f)
      const cached = _indexCache.get(filePath)
      if (cached) return cached

      try {
        const normalized = normalizePageIndex(
          JSON.parse(readFileSync(filePath, 'utf-8')) as unknown,
          path.basename(f, '.json'),
        )
        _indexCache.set(filePath, normalized)
        return [normalized]
      } catch (error) {
        warnings.push(`${f}: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    })
  _indexWarnings.set(indicesDir, warnings)
  return indices
}

export function flattenNodes(
  nodes: PageIndexNode[] | undefined,
  pathSoFar: string[] = [],
): Array<{ node: PageIndexNode; path: string[] }> {
  if (!Array.isArray(nodes)) return []
  const result: Array<{ node: PageIndexNode; path: string[] }> = []
  for (const node of nodes) {
    const nodePath = [...pathSoFar, node.title]
    result.push({ node, path: nodePath })
    if (node.children?.length) {
      result.push(...flattenNodes(node.children, nodePath))
    }
  }
  return result
}

export function inspectPageIndices(indicesDir: string): PageIndexInspection {
  try {
    const indices = loadPageIndices(indicesDir)
    return {
      fileCount: indices.length,
      documentCount: indices.length,
      nodeCount: indices.reduce((total, index) => total + flattenNodes(index.nodes).length, 0),
      ...((_indexWarnings.get(indicesDir)?.length ?? 0) > 0
        ? { error: _indexWarnings.get(indicesDir)!.join('; ') }
        : {}),
    }
  } catch (error) {
    return {
      fileCount: 0,
      documentCount: 0,
      nodeCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ─── Keyword scoring ──────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(tokenizeSecurityText(text))
}

function keywordScore(queryTokens: Set<string>, text: string): number {
  const nodeTokens = tokenize(text)
  let hits = 0
  for (const qt of queryTokens) {
    if (nodeTokens.has(qt)) hits++
  }
  return hits / Math.max(queryTokens.size, 1)
}

// ─── Public search ────────────────────────────────────────────────────────────

export function keywordTreeSearch(
  indices: PageIndex[],
  query: string,
  topK = 3
): TreeRetrievalResult[] {
  const queryTokens = tokenize(query)
  const candidates: TreeRetrievalResult[] = []

  for (const index of indices) {
    const flattened = flattenNodes(index.nodes)

    for (const { node, path: sectionPath } of flattened) {
      const textContent = [node.title, node.summary ?? '', node.text ?? ''].join(' ')
      const score = keywordScore(queryTokens, textContent)

      if (score > 0.1) {
        candidates.push({
          docName: index.document_name,
          sectionPath: sectionPath.join(' > '),
          pageRange:
            node.page_start != null
              ? `p.${node.page_start}${node.page_end ? '-' + node.page_end : ''}`
              : undefined,
          text: node.text ?? node.summary ?? node.title,
          relevanceNote: `keyword match score ${score.toFixed(2)}`,
          score,
        })
      }
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
