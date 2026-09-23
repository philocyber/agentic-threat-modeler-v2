import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { CORPORATE_CHUNK_OVERLAP, CORPORATE_CHUNK_SIZE, CORPORATE_EXTENSIONS } from './constants'
import { documentSections, parseDocument } from './document'
import { resolveKnowledgeRoot } from './corpus-paths'
import { rankSections, scopeMismatch, type EvidenceScope } from './ranking'

const ALLOWED_EXTENSIONS = new Set<string>(CORPORATE_EXTENSIONS)
export const MAX_CORPORATE_FILE_BYTES = 25 * 1024 * 1024

export type GlobalCorpusDomain = 'technical' | 'corporate'

export type GlobalCorpusDocument = {
  path: string
  content: string
  sha256: string
  sourceType: string
}

function corpusRoot(domain: GlobalCorpusDomain, rootPath?: string): string {
  return resolve(resolveKnowledgeRoot(rootPath), domain)
}

const corpusCache = new Map<GlobalCorpusDomain, { root: string; signature: string; documents: GlobalCorpusDocument[] }>()

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (directory === root && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) await walk(fullPath)
      else if (entry.isFile() && ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath)
      }
    }
  }
  await walk(root)
  return files.sort((a, b) => a.localeCompare(b))
}

export async function loadGlobalCorpusDocuments(
  domain: GlobalCorpusDomain,
  rootPath?: string,
): Promise<GlobalCorpusDocument[]> {
  const root = corpusRoot(domain, rootPath)
  const files = await listFiles(root)
  const stats = await Promise.all(files.map(async (filePath) => {
    try {
      const info = await stat(filePath)
      return { filePath, info }
    } catch (error) {
      throw new Error(`Cannot inspect corpus file ${filePath}`, { cause: error })
    }
  }))
  const signature = stats.map(({ filePath, info }) => `${filePath}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
    .join('\n')
  const cached = corpusCache.get(domain)
  if (cached?.root === root && cached.signature === signature) return cached.documents
  const documents: GlobalCorpusDocument[] = []
  for (const item of stats) {
    const { filePath, info } = item
    const relativePath = relative(root, resolve(filePath))
    if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) throw new Error('Corpus path escaped its root')
    try {
      if (!info.isFile() || info.size > MAX_CORPORATE_FILE_BYTES) throw new Error('File exceeds the 25 MiB indexing limit or is not a regular file')
      const content = await readFile(filePath, 'utf8')
      if (!parseDocument(content).body.trim()) throw new Error('Document has no indexable body text')
      const path = relativePath.split(sep).join('/')
      documents.push({
        path,
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
        sourceType: path.split('/')[0]?.replace(/[^a-z0-9_-]/gi, '_').toLowerCase() || 'document',
      })
    } catch (error) {
      throw new Error(`Cannot load corpus document ${relativePath}`, { cause: error })
    }
  }
  const sorted = documents.sort((left, right) => left.path.localeCompare(right.path))
  corpusCache.set(domain, { root, signature, documents: sorted })
  return sorted
}

export function clearGlobalCorpusCache(): void {
  corpusCache.clear()
}

export function chunkGlobalDocument(
  document: GlobalCorpusDocument,
  chunkSize = CORPORATE_CHUNK_SIZE,
  overlap = CORPORATE_CHUNK_OVERLAP,
): Array<GlobalCorpusDocument & ReturnType<typeof documentSections>[number] & { chunkIndex: number }> {
  return documentSections(document.content, chunkSize, overlap).map((section, chunkIndex) => ({ ...document, ...section, chunkIndex }))
}

export async function searchGlobalCorpus(
  domain: GlobalCorpusDomain,
  queryText: string,
  topK = 5,
  rootPath?: string,
  scope: EvidenceScope = {},
): Promise<Array<{ id: string; path: string; excerpt: string; score: number; metadata: Record<string, unknown> }>> {
  const chunks = (await loadGlobalCorpusDocuments(domain, rootPath)).flatMap(document => chunkGlobalDocument(document))
    .filter(chunk => !scopeMismatch(chunk.metadata, scope))
  return rankSections(chunks, queryText, chunk => `${chunk.sectionPath}\n${chunk.text}\n${Object.values(chunk.metadata).join(' ')}`)
    .filter(hit => hit.score > 0).slice(0, Math.max(1, Math.min(topK, 30)))
    .map(({ item, score }) => ({ id: createHash('sha256').update(`${item.path}:${item.sha256}:${item.start}:${item.end}`).digest('hex'), path: item.path, excerpt: item.text, score,
      metadata: { ...item.metadata, sha256: item.sha256, sectionPath: item.sectionPath, start: item.start, end: item.end, qualification: item.qualification },
    }))
}
