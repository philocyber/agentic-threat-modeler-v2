import { expect, it } from 'vitest'
import { canReuseIndexedChunk } from '../index-reuse'
import { RAG_INDEX_FORMAT_VERSION } from '../constants'

const metadata = { sha256: 'file-version', sectionPath: 'Authentication', qualification: 'Inferred', start: 0, end: 12 }
const existing = { document: 'source text', metadata }
it('does not reuse vectors from the truncated embedding format', () => {
  const updated = { ...metadata, embeddingFormatVersion: RAG_INDEX_FORMAT_VERSION }
  expect(canReuseIndexedChunk(existing, 'source text', updated)).toBe(false)
  expect(canReuseIndexedChunk({ document: 'source text', metadata: updated }, 'source text', updated)).toBe(true)
})
it('reuses exact text and embedding context regardless of property order', () => {
  expect(canReuseIndexedChunk(existing, 'source text', { ...metadata })).toBe(true)
})
it('reembeds changed text, source versions, sections, qualifications, and missing metadata', () => {
  expect(canReuseIndexedChunk(existing, 'changed text', metadata)).toBe(false)
  for (const key of ['sha256', 'sectionPath', 'qualification']) {
    expect(canReuseIndexedChunk(existing, 'source text', { ...metadata, [key]: 'changed' })).toBe(false)
  }
  expect(canReuseIndexedChunk(undefined, 'source text', metadata)).toBe(false)
  expect(canReuseIndexedChunk({ document: 'source text', metadata: null }, 'source text', metadata)).toBe(false)
})
