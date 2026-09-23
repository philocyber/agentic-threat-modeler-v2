import { describe, expect, it } from 'vitest'
import { isSafeSvgUrl, MAX_SVG_CHARS, sanitizeCss, sanitizeSvg } from '@/lib/security/sanitize-svg'

describe('isSafeSvgUrl', () => {
  it('allows fragment identifiers used by Mermaid', () => {
    expect(isSafeSvgUrl('#edge-1')).toBe(true)
    expect(isSafeSvgUrl('')).toBe(true)
  })

  it('rejects javascript, data, and external URLs', () => {
    expect(isSafeSvgUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeSvgUrl('data:text/html,x')).toBe(false)
    expect(isSafeSvgUrl('https://evil.example/x')).toBe(false)
    expect(isSafeSvgUrl('#foo:bar')).toBe(false)
  })
})

describe('sanitizeSvg', () => {
  it('keeps a static diagram subset', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/><text>ok</text></svg>'
    expect(sanitizeSvg(svg)).toContain('<path d="M0 0h1"/>')
    expect(sanitizeSvg(svg)).toContain('<text>ok</text>')
  })

  it('strips script and foreignObject but keeps diagram CSS', () => {
    const svg = [
      '<svg>',
      '<script>alert(1)</script>',
      '<foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject>',
      '<style>#n{fill:#fff}@import url(https://evil);</style>',
      '<circle r="2"/>',
      '</svg>',
    ].join('')
    const clean = sanitizeSvg(svg)
    expect(clean.toLowerCase()).not.toContain('script')
    expect(clean.toLowerCase()).not.toContain('foreignobject')
    expect(clean.toLowerCase()).not.toContain('iframe')
    expect(clean).toContain('<style>#n{fill:#fff}</style>')
    expect(clean).not.toMatch(/@import/i)
    expect(clean).toContain('<circle r="2"/>')
  })

  it('strips scripted values from CSS', () => {
    expect(sanitizeCss('color:red; x:expression(alert(1)); url(javascript:alert(1))')).not.toMatch(
      /expression\s*\(|javascript:/i,
    )
  })

  it('strips event handlers', () => {
    const svg = '<svg><rect width="1" height="1" onload="alert(1)" onerror=alert(2) /></svg>'
    const clean = sanitizeSvg(svg)
    expect(clean.toLowerCase()).not.toMatch(/\son[a-z]+=/)
    expect(clean).toContain('<rect')
  })

  it('neutralizes javascript and data URLs in href', () => {
    const svg = [
      '<svg>',
      '<a href="javascript:alert(1)">x</a>',
      '<use xlink:href="data:image/svg+xml,x"/>',
      '<a href="#node-1">ok</a>',
      '</svg>',
    ].join('')
    const clean = sanitizeSvg(svg)
    expect(clean).not.toMatch(/javascript:/i)
    expect(clean).not.toMatch(/data:/i)
    expect(clean).toContain('href="#node-1"')
  })

  it('returns empty for oversized payloads', () => {
    expect(sanitizeSvg('x'.repeat(MAX_SVG_CHARS + 1))).toBe('')
  })
})
