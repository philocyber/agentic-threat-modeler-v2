/**
 * Sanitizes the HAST produced by react-markdown for RFC/analysis content.
 * Does not parse raw HTML (no rehype-raw). Strips disallowed tags, event
 * handlers, and javascript:/data: URLs (CWE-79).
 */

const ALLOWED_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'div',
  'span',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'b',
  'i',
  'del',
  's',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
])

const ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title']),
  th: new Set(['align', 'colSpan', 'rowSpan']),
  td: new Set(['align', 'colSpan', 'rowSpan']),
  code: new Set(['className']),
  pre: new Set(['className']),
  ol: new Set(['start']),
}

type HastNode = {
  type?: unknown
  tagName?: unknown
  properties?: unknown
  children?: unknown
  value?: unknown
}

function isHastNode(value: unknown): value is HastNode {
  return typeof value === 'object' && value !== null
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) record[key] = entry
  return record
}

export function safeMarkdownUrl(url: string): string {
  const trimmed = url.trim()
  if (/^(javascript|vbscript|data):/i.test(trimmed)) return ''
  return trimmed
}

function classNames(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

function sanitizeProperties(
  tag: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = ATTRS[tag]
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (/^on/i.test(key) || key === 'dangerouslySetInnerHTML') continue
    if (key === 'href' || key === 'src') {
      const safe = typeof value === 'string' ? safeMarkdownUrl(value) : ''
      if (safe) next[key] = safe
      continue
    }
    if (key === 'className' && tag === 'code') {
      const names = classNames(value).filter((name) => /^language-[\w-]+$/.test(name))
      if (names.length > 0) next.className = names
      continue
    }
    if (allowed?.has(key)) next[key] = value
  }
  return next
}

export function sanitizeHast(node: unknown): void {
  if (!isHastNode(node) || !Array.isArray(node.children)) return

  const next: unknown[] = []
  for (const child of node.children) {
    if (!isHastNode(child)) {
      next.push(child)
      continue
    }
    if (child.type === 'raw') continue
    if (child.type === 'element' && typeof child.tagName === 'string') {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        sanitizeHast(child)
        if (Array.isArray(child.children)) next.push(...child.children)
        continue
      }
      const properties = recordFromUnknown(child.properties)
      if (properties) child.properties = sanitizeProperties(child.tagName, properties)
    }
    sanitizeHast(child)
    next.push(child)
  }
  node.children = next
}

export function rehypeSafeMarkdown(): (tree: unknown) => void {
  return (tree: unknown) => {
    sanitizeHast(tree)
  }
}
