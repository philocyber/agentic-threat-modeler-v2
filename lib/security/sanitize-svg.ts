/**
 * Constrains untrusted SVG (e.g. Mermaid output from LLM/RFC content) to a
 * static subset before DOM insertion. CWE-79: no scripts, event handlers,
 * foreignObject, or javascript:/data: URLs. `<style>` is kept so Mermaid
 * colors survive; CSS is stripped of imports and scripted values.
 */

export const MAX_SVG_CHARS = 400_000

const BLOCKED_ELEMENTS = [
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'set',
  'animate',
  'animateTransform',
  'animateMotion',
] as const

const WRAPPED_BLOCK = new RegExp(
  `<(?:${BLOCKED_ELEMENTS.join('|')})\\b[^>]*>[\\s\\S]*?</(?:${BLOCKED_ELEMENTS.join('|')})>`,
  'gi',
)

const BLOCKED_TAG = new RegExp(
  `</?(?:${BLOCKED_ELEMENTS.join('|')})\\b[^>]*>`,
  'gi',
)

const EVENT_HANDLER_ATTR = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

const URL_ATTR = /((?:xlink:)?href|src|action|formaction)\s*=\s*(["'])([\s\S]*?)\2/gi

export function isSafeSvgUrl(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '#') return true
  if (trimmed.startsWith('#')) return !trimmed.includes(':')
  return false
}

export function sanitizeCss(css: string): string {
  return css
    .replace(/@import\b[\s\S]*?(;|$)/gi, '')
    .replace(/expression\s*\(/gi, 'invalid(')
    .replace(/url\s*\(\s*(['"]?)\s*(?:javascript|vbscript|data):/gi, 'url($1')
    .replace(/javascript\s*:/gi, '')
    .replace(/behavior\s*:/gi, '')
    .replace(/-moz-binding\s*:/gi, '')
}

export function sanitizeSvg(svg: string): string {
  if (svg.length > MAX_SVG_CHARS) return ''

  let out = svg.replace(WRAPPED_BLOCK, '').replace(BLOCKED_TAG, '')
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, css: string) => {
    return `<style>${sanitizeCss(css)}</style>`
  })
  out = out.replace(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (_match, quote: string, css: string) => {
    return ` style=${quote}${sanitizeCss(css)}${quote}`
  })
  out = out.replace(EVENT_HANDLER_ATTR, '')
  out = out.replace(URL_ATTR, (_full, attr: string, quote: string, url: string) => {
    return isSafeSvgUrl(url) ? `${attr}=${quote}${url.trim()}${quote}` : `${attr}=${quote}#${quote}`
  })
  return out
}
