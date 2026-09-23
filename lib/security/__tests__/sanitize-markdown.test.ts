import { describe, expect, it } from 'vitest'
import { rehypeSafeMarkdown, safeMarkdownUrl, sanitizeHast } from '@/lib/security/sanitize-markdown'

describe('safeMarkdownUrl', () => {
  it('allows http(s) and relative links', () => {
    expect(safeMarkdownUrl('https://example.com/rfc')).toBe('https://example.com/rfc')
    expect(safeMarkdownUrl('/results/abc')).toBe('/results/abc')
  })

  it('strips javascript and data URLs', () => {
    expect(safeMarkdownUrl('javascript:alert(1)')).toBe('')
    expect(safeMarkdownUrl('  DATA:text/html,x')).toBe('')
    expect(safeMarkdownUrl('vbscript:msgbox(1)')).toBe('')
  })
})

describe('sanitizeHast', () => {
  it('unwraps disallowed tags and drops raw HTML nodes', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            { type: 'element', tagName: 'script', properties: {}, children: [{ type: 'text', value: 'alert(1)' }] },
            { type: 'text', value: 'safe' },
          ],
        },
        { type: 'raw', value: '<img src=x onerror=alert(1)>' },
      ],
    }
    sanitizeHast(tree)
    expect(JSON.stringify(tree)).not.toContain('script')
    expect(JSON.stringify(tree)).not.toContain('raw')
    expect(JSON.stringify(tree)).toContain('safe')
  })

  it('strips event handlers and javascript hrefs', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'a',
          properties: { href: 'javascript:alert(1)', onClick: 'alert(1)', title: 'x' },
          children: [{ type: 'text', value: 'click' }],
        },
      ],
    }
    sanitizeHast(tree)
    const anchor = tree.children[0] as {
      properties: Record<string, unknown>
    }
    expect(anchor.properties.href).toBeUndefined()
    expect(anchor.properties.onClick).toBeUndefined()
    expect(anchor.properties.title).toBe('x')
  })

  it('keeps mermaid language class and drops other class names', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-mermaid', 'onerror'] },
          children: [],
        },
      ],
    }
    sanitizeHast(tree)
    const code = tree.children[0] as { properties: { className?: string[] } }
    expect(code.properties.className).toEqual(['language-mermaid'])
  })
})

describe('rehypeSafeMarkdown', () => {
  it('returns a transformer that sanitizes the tree', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'element', tagName: 'iframe', properties: { src: 'https://evil' }, children: [] }],
    }
    rehypeSafeMarkdown()(tree)
    expect(tree.children).toEqual([])
  })
})
