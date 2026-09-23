import { describe, expect, it } from 'vitest'
import { documentSections, parseDocument, assertSectionCoverage } from '../document'

describe('deterministic Markdown coverage', () => {
  it('covers a long book with Unicode, long lines and headings without gaps', () => {
    const text = '# Book\n' + 'Long content 🔒 español. '.repeat(8000) + '\n## Last chapter\nThe final qualification must survive.'
    const chunks = documentSections(text, 1200, 180)
    expect(chunks).toEqual(documentSections(text, 1200, 180))
    expect(chunks.every(chunk => chunk.text.length <= 1200)).toBe(true)
    expect(chunks.at(-1)?.text).toContain('final qualification')
    expect(() => assertSectionCoverage(parseDocument(text).body, chunks)).not.toThrow()
    expect(() => assertSectionCoverage(parseDocument(text).body, chunks.slice(0, -1))).toThrow('incomplete')
  })
  it('keeps fitting code blocks intact and ignores headings inside code', () => {
    const code = '```python\n# This is code, not a chapter\nprint("hello")\n```'
    const chunks = documentSections('# Chapter\n' + 'Intro sentence. '.repeat(12) + '\n' + code + '\nTail text.', 200, 30)
    expect(chunks.some(chunk => chunk.text.includes(code))).toBe(true)
    expect(chunks.every(chunk => chunk.sectionPath === 'Chapter')).toBe(true)
  })
  it('preserves table headers as context when a long table must span chunks', () => {
    const table = '| Control | Status |\n| --- | --- |\n' + '| Authentication | Unknown |\n'.repeat(100)
    const chunks = documentSections('# Controls\n' + table, 200, 30)
    expect(chunks.at(-1)?.structureContext).toContain('| Control | Status |')
    expect(chunks.at(-1)?.text).toContain('Unknown')
  })
})
