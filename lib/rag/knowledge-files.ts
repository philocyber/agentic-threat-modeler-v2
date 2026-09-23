import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { parseDocument } from './document'
import { randomUUID } from 'node:crypto'
import { CORPORATE_EXTENSIONS, TECHNICAL_EXTENSIONS as SHARED_TECHNICAL_EXTENSIONS } from './constants'
import { CORPUS_DIRECTORIES, resolveKnowledgeRoot } from './corpus-paths'
import { extname, join, relative, resolve, sep } from 'node:path'

export type KnowledgeDomain = 'technical' | 'corporate'

export type KnowledgeDestination = {
  id: string
  domain: KnowledgeDomain
  label: string
  description: string
  relativeDirectory: string
  allowedExtensions: string[]
}

export type KnowledgeFileSummary = {
  path: string
  domain: KnowledgeDomain
  size: number
  modifiedAt: string
  extension: string
  retrievalStatus?: 'eligible' | 'skipped'
  retrievalNote?: string
}

export const MAX_KNOWLEDGE_FILES_PER_UPLOAD = 20
export const MAX_KNOWLEDGE_FILE_BYTES = 25 * 1024 * 1024
const MAX_KNOWLEDGE_UPLOAD_BYTES = 100 * 1024 * 1024

const TEXT_EXTENSIONS = [...CORPORATE_EXTENSIONS]
const TECHNICAL_EXTENSIONS = [...SHARED_TECHNICAL_EXTENSIONS]

export const KNOWLEDGE_DESTINATIONS: KnowledgeDestination[] = [
  { id: 'technical-general', domain: 'technical', label: 'Technical / General', description: 'General security engineering, platforms and implementation guidance.', relativeDirectory: 'technical', allowedExtensions: TECHNICAL_EXTENSIONS },
  { id: 'technical-research', domain: 'technical', label: 'Technical / Research', description: 'Security research, advisories and attack technique analysis.', relativeDirectory: 'technical/research', allowedExtensions: TECHNICAL_EXTENSIONS },
  { id: 'technical-ai', domain: 'technical', label: 'Technical / AI threats', description: 'AI, GenAI and agentic threat patterns.', relativeDirectory: 'technical/ai_threats', allowedExtensions: TECHNICAL_EXTENSIONS },
  { id: 'technical-books', domain: 'technical', label: 'Technical / Books & frameworks', description: 'Long-form references and security frameworks.', relativeDirectory: 'technical/books', allowedExtensions: TECHNICAL_EXTENSIONS },
  { id: 'technical-controls', domain: 'technical', label: 'Technical / Risks & mitigations', description: 'Threat-to-control mappings, mitigations and defensive patterns.', relativeDirectory: 'technical/risks_mitigations', allowedExtensions: TECHNICAL_EXTENSIONS },
  { id: 'corporate-general', domain: 'corporate', label: 'Corporate / General', description: 'Shared organizational context used by every analysis.', relativeDirectory: 'corporate', allowedExtensions: TEXT_EXTENSIONS },
  { id: 'corporate-architecture', domain: 'corporate', label: 'Corporate / Architecture', description: 'Reference architectures, ADRs, RFCs and platform standards.', relativeDirectory: 'corporate/architecture', allowedExtensions: TEXT_EXTENSIONS },
  { id: 'corporate-policies', domain: 'corporate', label: 'Corporate / Policies', description: 'Security policies, control requirements and approved exceptions.', relativeDirectory: 'corporate/policies', allowedExtensions: TEXT_EXTENSIONS },
  { id: 'corporate-incidents', domain: 'corporate', label: 'Corporate / Incidents', description: 'Sanitized incident learnings and recurring organizational risks.', relativeDirectory: 'corporate/incidents', allowedExtensions: TEXT_EXTENSIONS },
]


export function getKnowledgeDestination(id: string, domain: string): KnowledgeDestination | null {
  return KNOWLEDGE_DESTINATIONS.find((destination) => destination.id === id && destination.domain === domain) ?? null
}

export function sanitizeKnowledgeFilename(filename: string): string {
  const leaf = filename.normalize('NFKC').split(/[\\/]/).pop() ?? ''
  const extension = extname(leaf).toLowerCase()
  const stem = leaf.slice(0, Math.max(0, leaf.length - extension.length))
    .replace(/[^a-zA-Z0-9._ -]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 100)
  return `${stem || 'document'}${extension}`
}

function destinationDirectory(destination: KnowledgeDestination): string {
  const KNOWLEDGE_ROOT = resolveKnowledgeRoot()
  const directory = resolve(KNOWLEDGE_ROOT, destination.relativeDirectory)
  if (directory !== KNOWLEDGE_ROOT && !directory.startsWith(`${KNOWLEDGE_ROOT}${sep}`)) {
    throw new Error('Invalid knowledge destination')
  }
  return directory
}

async function availablePath(directory: string, filename: string): Promise<{ path: string; filename: string }> {
  const extension = extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)
  for (let index = 1; index <= 999; index += 1) {
    const candidate = index === 1 ? filename : `${stem}-${index}${extension}`
    const candidatePath = join(directory, candidate)
    try {
      await stat(candidatePath)
    } catch {
      return { path: candidatePath, filename: candidate }
    }
  }
  throw new Error(`Could not allocate a filename for ${filename}`)
}

function validateContent(extension: string, content: Buffer): void {
  if (extension === '.pdf') {
    if (content.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('The PDF signature is invalid')
    return
  }
  if (content.includes(0)) throw new Error('Text documents cannot contain null bytes')
  parseDocument(content.toString('utf8'))
}

export async function saveKnowledgeFiles(params: {
  destination: KnowledgeDestination
  files: File[]
  replaceExisting: boolean
}): Promise<Array<{ originalName: string; savedName: string; path: string; size: number }>> {
  const KNOWLEDGE_ROOT = resolveKnowledgeRoot()
  const { destination, files, replaceExisting } = params
  if (files.length === 0) throw new Error('Select at least one document')
  if (files.length > MAX_KNOWLEDGE_FILES_PER_UPLOAD) {
    throw new Error(`Upload at most ${MAX_KNOWLEDGE_FILES_PER_UPLOAD} documents at once`)
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > MAX_KNOWLEDGE_UPLOAD_BYTES) throw new Error('The upload batch exceeds 100 MB')

  const prepared: Array<{ file: File; safeName: string; content: Buffer }> = []
  const batchNames = new Set<string>()
  for (const file of files) {
    if (file.size <= 0) throw new Error(`${file.name} is empty`)
    if (file.size > MAX_KNOWLEDGE_FILE_BYTES) throw new Error(`${file.name} exceeds the 25 MB limit`)
    const safeName = sanitizeKnowledgeFilename(file.name)
    const extension = extname(safeName).toLowerCase()
    if (!destination.allowedExtensions.includes(extension)) {
      throw new Error(`${file.name} is not supported for ${destination.label}`)
    }
    if (replaceExisting && batchNames.has(safeName.toLowerCase())) {
      throw new Error(`The upload contains more than one file named ${safeName}`)
    }
    batchNames.add(safeName.toLowerCase())
    const content = Buffer.from(await file.arrayBuffer())
    validateContent(extension, content)
    prepared.push({ file, safeName, content })
  }

  const directory = destinationDirectory(destination)
  await mkdir(directory, { recursive: true })
  const saved: Array<{ originalName: string; savedName: string; path: string; size: number }> = []

  for (const { file, safeName, content } of prepared) {
    const target = replaceExisting
      ? { path: join(directory, safeName), filename: safeName }
      : await availablePath(directory, safeName)
    const temporaryPath = `${target.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, target.path)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
    saved.push({
      originalName: file.name,
      savedName: target.filename,
      path: relative(KNOWLEDGE_ROOT, target.path).split(sep).join('/'),
      size: file.size,
    })
  }
  return saved
}

export async function listKnowledgeFiles(rootPath?: string): Promise<KnowledgeFileSummary[]> {
  const KNOWLEDGE_ROOT = resolveKnowledgeRoot(rootPath)
  const files: KnowledgeFileSummary[] = []
  async function walk(directory: string, domain: KnowledgeDomain): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) await walk(fullPath, domain)
      else if (entry.isFile()) {
        const info = await stat(fullPath)
        files.push({
          path: relative(KNOWLEDGE_ROOT, fullPath).split(sep).join('/'),
          domain,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          extension: extname(entry.name).toLowerCase(),
        })
      }
    }
  }
  await Promise.all(CORPUS_DIRECTORIES.map(({ directory, domain }) => walk(join(KNOWLEDGE_ROOT, directory), domain)))
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const allowed = file.domain === 'corporate' ? CORPORATE_EXTENSIONS : SHARED_TECHNICAL_EXTENSIONS
    if (!(allowed as readonly string[]).includes(file.extension)) {
      file.retrievalStatus = 'skipped'; file.retrievalNote = 'Unsupported format'; continue
    }
    if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
      file.retrievalStatus = 'skipped'; file.retrievalNote = 'File exceeds 25 MiB'; continue
    }
    try {
      if (file.extension !== '.pdf') parseDocument(await readFile(resolve(KNOWLEDGE_ROOT, file.path), 'utf8'))
      file.retrievalStatus = 'eligible'; file.retrievalNote = 'File checks passed; verify extraction and synchronization in index logs'
    } catch {
      file.retrievalStatus = 'skipped'; file.retrievalNote = 'Unreadable or RTF content; export clean UTF-8 text'
    }
  }
  return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
}
