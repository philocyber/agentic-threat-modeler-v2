import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPageIndexCache,
  flattenNodes,
  inspectPageIndices,
  keywordTreeSearch,
  loadPageIndices,
  normalizePageIndex,
} from '@/lib/rag/tree-retriever'
import { tokenizeSecurityText } from '@/lib/rag/tokenize'

afterEach(() => {
  clearPageIndexCache()
})

describe('normalizePageIndex', () => {
  it('accepts the Python page_indices shape (tree / doc_name / start_page)', () => {
    const index = normalizePageIndex({
      doc_name: 'nist.ai.100-1',
      doc_path: 'knowledge_base/ai_threats/nist.ai.100-1.pdf',
      tree: [
        {
          title: 'AI RMF',
          start_page: 1,
          end_page: 2,
          summary: 'Artificial intelligence risk management',
          children: [{ title: 'Govern', start_page: 2, summary: 'Govern function' }],
        },
      ],
    })
    expect(index.document_name).toBe('nist.ai.100-1')
    expect(index.nodes).toHaveLength(1)
    expect(index.nodes[0]?.page_start).toBe(1)
    expect(flattenNodes(index.nodes)).toHaveLength(2)
  })

  it('returns an empty node list when nodes is missing instead of throwing', () => {
    expect(flattenNodes(undefined)).toEqual([])
    expect(keywordTreeSearch([normalizePageIndex({ doc_name: 'empty' })], 'risk management')).toEqual([])
  })
})

describe('loadPageIndices', () => {
  it('loads synthetic page-index fixtures and searches them without throwing', () => {
    const indices = loadPageIndices(join(process.cwd(), 'test', 'fixtures', 'page-indices'))
    expect(indices.length).toBeGreaterThan(0)
    expect(indices.every((index) => Array.isArray(index.nodes))).toBe(true)
    const hits = keywordTreeSearch(indices, 'artificial intelligence risk', 3)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.docName.length).toBeGreaterThan(0)
  })

  it('inspects a directory of mixed tree JSON without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'page-indices-'))
    writeFileSync(
      join(dir, 'sample.tree.json'),
      JSON.stringify({
        doc_name: 'sample',
        tree: [{ title: 'Intro', summary: 'Threat modeling for APIs', children: [] }],
      }),
    )
    const inspection = inspectPageIndices(dir)
    expect(inspection).toMatchObject({ fileCount: 1, nodeCount: 1 })
    expect(inspection.error).toBeUndefined()
  })

  it('isolates one corrupt page index while keeping valid indices searchable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'page-indices-corrupt-'))
    writeFileSync(join(dir, 'broken.json'), '{ definitely not json')
    writeFileSync(join(dir, 'valid.json'), JSON.stringify({
      doc_name: 'valid',
      tree: [{ title: 'JWT API', summary: 'JWT validation for the API gateway' }],
    }))
    const indices = loadPageIndices(dir)
    const inspection = inspectPageIndices(dir)
    expect(indices).toHaveLength(1)
    expect(keywordTreeSearch(indices, 'jwt api')).toHaveLength(1)
    expect(inspection).toMatchObject({ documentCount: 1, nodeCount: 1 })
    expect(inspection.error).toMatch(/broken\.json/)
  })

  it('retains security acronyms that the common tokenizer would otherwise drop', () => {
    expect(tokenizeSecurityText('API JWT IAM XSS SQL LLM and oauth')).toEqual([
      'api', 'jwt', 'iam', 'xss', 'sql', 'llm', 'oauth',
    ])
  })
})
