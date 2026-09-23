import { resolve } from 'node:path'
import { getConfig } from '@/lib/config'

export const SPECIALIZED_TECHNICAL_DIRECTORIES = ['research', 'ai_threats', 'books', 'risks_mitigations'] as const

// Legacy top-level technical folders remain readable; new uploads use technical/.
export const CORPUS_DIRECTORIES = [
  { directory: 'technical', domain: 'technical' },
  ...SPECIALIZED_TECHNICAL_DIRECTORIES.map((directory) => ({ directory, domain: 'technical' as const })),
  { directory: 'corporate', domain: 'corporate' },
] as const

export function resolveKnowledgeRoot(rootPath?: string): string {
  return resolve(rootPath ?? getConfig().rag.knowledgeBasePath)
}
