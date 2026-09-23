import { describe, expect, it } from 'vitest'
import { documentSections, parseDocument } from '../document'
import { makePassage, validateEvidenceSources, validateOutputEvidence } from '../evidence'
import { rankSections, scopeMismatch } from '../ranking'
import { buildQueryVariants, selectPassageWindow } from '../router'

const source = { id: 'chunk-1', source: 'roles.md', document: 'SAMPLE_READER grants are unknown. Export effective grants before assigning blast radius.', domain: 'corporate' as const, metadata: { sha256: 'version-1', system: 'Example Service', assertion_type: 'UNKNOWN' } }

describe('evidence integrity and applicability', () => {
  it('keeps IDs stable across query order but versions changed content', () => {
    expect(makePassage(source, 'q1').citationId).toBe(makePassage(source, 'q2').citationId)
    expect(makePassage(source, 'q1').citationId).not.toBe(makePassage({ ...source, document: 'Only warehouse read grants.' }, 'q1').citationId)
  })
  it('rejects invented retrieval and altered quotations, including RAG OFF', () => {
    const p = makePassage(source, 'q1')
    const valid = { sourceType: 'rag' as const, sourceName: p.citationId, excerpt: 'SAMPLE_READER grants are unknown.' }
    expect(validateEvidenceSources([valid], []).rejected).toBe(1)
    expect(validateEvidenceSources([valid], []).sources).toHaveLength(1)
    expect(validateEvidenceSources([valid], []).sources[0]).toMatchObject({ referenceStatus: 'unverified' })
    expect(validateEvidenceSources([{ ...valid, excerpt: 'SAMPLE_READER grants are unrestricted.' }], [p]).rejected).toBe(0)
    expect(validateEvidenceSources([{ ...valid, excerpt: 'SAMPLE_READER grants are unrestricted.' }], [p]).sources[0]).toMatchObject({
      citationId: p.citationId, referenceStatus: 'verified', excerpt: p.excerpt,
    })
    expect(validateEvidenceSources([valid], [p]).sources[0]).toMatchObject({ citationId: p.citationId, sourceVersion: 'version-1', referenceStatus: 'verified', sourceName: 'roles.md' })
    expect(validateOutputEvidence({ threats: [{ evidenceSources: [valid] }] }, { passages: [] }).threats[0]!.evidenceSources).toEqual([
      expect.objectContaining({ excerpt: valid.excerpt, referenceStatus: 'unverified' }),
    ])
  })
  it('retains document metadata and introductory qualifications on later chunks', () => {
    const sections = documentSections('---\nsystem: Example Service\nas_of: 2026-08-31\nassertion_type: INFERRED\n---\n# Review\n\nThis is INFERRED analysis, not verified configuration.\n\n## Memory\n\nNamespace isolation is unknown.\n\n## Identity\n\nThe executor uses a shared principal.')
    expect(sections.at(-1)).toMatchObject({ sectionPath: 'Review > Identity', metadata: { system: 'Example Service', as_of: '2026-08-31' } })
    expect(sections.at(-1)?.qualification).toContain('not verified configuration')
    expect(sections.every(s => !s.text.includes('assertion_type:'))).toBe(true)
  })
  it('retains late exceptions that the former 420-character rendering dropped', () => {
    const document = `${'Memory design context. '.repeat(30)}Isolation controls are UNKNOWN, not absent.`
    expect(selectPassageWindow(document, 'memory isolation')).toContain('UNKNOWN, not absent')
  })
  it('finds a late relevant section rather than the first generic keyword', () => {
    const document = `# Intro\nGeneral security.\n${'Marketing context. '.repeat(180)}\n\n## Grants\nSAMPLE_READER has SELECT on REPORTING only.\n\n## Other\nUnrelated appendix.`
    const selected = selectPassageWindow(document, 'SAMPLE_READER SELECT REPORTING')
    expect(selected).toContain('SELECT on REPORTING only')
    expect(selected.length).toBeLessThanOrEqual(2400)
  })
  it('preserves the question after character 240', () => {
    const query = `${'Context '.repeat(40)}What grants does SAMPLE_READER inherit?`
    expect(buildQueryVariants({ query }, null)[0]).toContain('SAMPLE_READER inherit?')
  })
  it('filters contradictory scope without upgrading unknown metadata', () => {
    expect(scopeMismatch({ system: 'Other' }, { system: 'Example Service' })).toBe('different_system')
    expect(scopeMismatch({ system: 'Sample App', aliases: '[Example Service, Review Tool]' }, { system: 'Example Service' })).toBeNull()
    expect(scopeMismatch({ environment: 'staging' }, { environment: 'production' })).toBe('different_environment')
    expect(scopeMismatch({ as_of: '2026-10-01' }, { asOf: '2026-09-08' })).toBe('future_source')
    expect(scopeMismatch({}, { system: 'Example Service' })).toBeNull()
  })
  it('ranks actual answer sections above broad guides and abstains on unrelated content', () => {
    const documents = ['A playbook about organizational security and RAG.', 'SAMPLE_READER has SELECT on REPORTING only.', 'Payroll policies.']
    expect(rankSections(documents, 'SAMPLE_READER grants REPORTING', s => s)[0]?.item).toBe(documents[1])
    expect(rankSections(['Payroll policy'], 'memory namespace isolation', s => s)[0]?.score).toBe(0)
  })
  it('rejects RTF disguised as Markdown with actionable remediation', () => {
    expect(() => parseDocument('{\\rtf1\\ansi raw rich text}')).toThrow('Export this document')
  })
})
