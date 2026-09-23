import { tokenizeSecurityText } from './tokenize'

const STOP = new Set('this that with from have what which where when these those their about into below above system component threat threats evidence analysis analyze perform validate current described specific query question'.split(' '))
export function terms(text: string): string[] { return tokenizeSecurityText(text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')).filter(t => !STOP.has(t)) }

/** BM25 over the actual returned sections, not words scattered across a whole file. */
export function rankSections<T>(items: T[], query: string, textOf: (item: T) => string): Array<{ item: T; score: number }> {
  const queryTerms = [...new Set(terms(query))]
  const docs = items.map(item => terms(textOf(item)))
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, docs.length) || 1
  const df = new Map(queryTerms.map(t => [t, docs.filter(d => d.includes(t)).length]))
  return items.map((item, i) => {
    const doc = docs[i]!
    const score = queryTerms.reduce((sum, term) => {
      const tf = doc.filter(t => t === term).length
      const idf = Math.log(1 + (items.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
      return sum + idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / avg))
    }, 0)
    return { item, score }
  }).sort((a, b) => b.score - a.score)
}

export type EvidenceScope = { system?: string | undefined; environment?: string | undefined; asOf?: string | undefined }
const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
export function scopeMismatch(metadata: Record<string, unknown>, scope: EvidenceScope): string | null {
  const systems = [metadata.system, metadata.system_id, metadata.aliases].filter(v => typeof v === 'string').flatMap(v => String(v).split(/[,;|\[\]]/)).map(normalized).filter(Boolean)
  const requestedSystem = scope.system ? normalized(scope.system) : ''
  if (requestedSystem && systems.length && !systems.some(name => name === requestedSystem || ` ${requestedSystem} `.includes(` ${name} `))) return 'different_system'
  if (scope.environment && typeof metadata.environment === 'string' && normalized(metadata.environment) !== normalized(scope.environment)) return 'different_environment'
  const date = metadata.effective_at ?? metadata.as_of
  if (scope.asOf && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date > scope.asOf) return 'future_source'
  return null
}
