import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  calculateRAGCorpusSnapshot,
  invalidateRAGIndexState,
  evaluateRAGIndexReadiness,
  readRAGIndexState,
  writeRAGIndexState,
} from '../index-state'

const temporaryRoots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentic-tm-index-state-'))
  temporaryRoots.push(root)
  await mkdir(path.join(root, 'technical'), { recursive: true })
  await writeFile(path.join(root, 'technical', 'guide.md'), '# Security guide\nOriginal content')
  return root
}

describe('RAG index state', () => {
  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
  })

  it('blocks an unchanged corpus after a successful index', async () => {
    const root = await fixture()
    const snapshot = await calculateRAGCorpusSnapshot('embed-model', root)
    const state = await writeRAGIndexState(snapshot, { indexedAt: '2026-08-21T12:00:00.000Z', rootPath: root })

    expect(evaluateRAGIndexReadiness(await calculateRAGCorpusSnapshot('embed-model', root), state))
      .toMatchObject({ needsReindex: false, reason: 'up-to-date' })
    expect(await readRAGIndexState(root)).toEqual(state)
  })

  it('keeps interrupted rebuilds recoverable after removing an old success receipt', async () => {
    const root = await fixture()
    const snapshot = await calculateRAGCorpusSnapshot('embed-model', root)
    await writeRAGIndexState(snapshot, { rootPath: root })
    await invalidateRAGIndexState(root)
    expect(evaluateRAGIndexReadiness(snapshot, await readRAGIndexState(root)))
      .toMatchObject({ needsReindex: true, reason: 'never-indexed' })
  })

  it('preserves the previous published receipt when a new inventory is incomplete', async () => {
    const root = await fixture()
    const snapshot = await calculateRAGCorpusSnapshot('embed-model', root)
    const previous = await writeRAGIndexState(snapshot, { rootPath: root })
    await expect(writeRAGIndexState(snapshot, { rootPath: root, collections: {}, sources: [] })).rejects.toThrow('incomplete corpus inventory')
    expect(await readRAGIndexState(root)).toEqual(previous)
  })

  it('publishes all collection pointers and the source inventory together', async () => {
    const root = await fixture()
    const snapshot = await calculateRAGCorpusSnapshot('embed-model', root)
    const names = ['tm_technical', 'tm_books', 'tm_research', 'tm_ai_threats', 'tm_risks_mitigations', 'tm_technical_catalog', 'tm_corporate']
    const collections = Object.fromEntries(names.map(name => [name, { name: `${name}_generation`, count: name === 'tm_technical' || name === 'tm_technical_catalog' ? 1 : 0 }]))
    const sources = [{ path: 'technical/guide.md', sha256: 'a'.repeat(64), chunks: 1 }]
    const state = await writeRAGIndexState(snapshot, { rootPath: root, collections, sources })
    expect(await readRAGIndexState(root)).toEqual(state)
    await expect(writeRAGIndexState(snapshot, { rootPath: root, collections, sources: [{ ...sources[0]!, chunks: 2 }] })).rejects.toThrow('incomplete')
    expect(await readRAGIndexState(root)).toEqual(state)
  })

  it('rejects malformed published inventories when reading a receipt', async () => {
    const root = await fixture()
    const snapshot = await calculateRAGCorpusSnapshot('embed-model', root)
    const state = await writeRAGIndexState(snapshot, { rootPath: root })
    await writeFile(path.join(root, '.rag-index-state.json'), JSON.stringify({ ...state, collections: { tm_technical: null }, sources: [] }))
    expect(await readRAGIndexState(root)).toBeNull()
  })

  it('detects file content changes', async () => {
    const root = await fixture()
    const original = await calculateRAGCorpusSnapshot('embed-model', root)
    const state = await writeRAGIndexState(original, { rootPath: root })
    await writeFile(path.join(root, 'technical', 'guide.md'), '# Security guide\nChanged content')

    expect(evaluateRAGIndexReadiness(await calculateRAGCorpusSnapshot('embed-model', root), state))
      .toMatchObject({ needsReindex: true, reason: 'knowledge-files-changed' })
  })

  it('requires rebuilding the legacy index even when source files and model are unchanged', async () => {
    const root = await fixture()
    const snapshot = await calculateRAGCorpusSnapshot('embed-model', root)
    const state = await writeRAGIndexState(snapshot, { rootPath: root })
    await writeFile(path.join(root, '.rag-index-state.json'), JSON.stringify({ ...state, version: 4 }))
    expect(evaluateRAGIndexReadiness(snapshot, await readRAGIndexState(root)).needsReindex).toBe(true)
  })

  it('detects an embedding model change even when files are unchanged', async () => {
    const root = await fixture()
    const original = await calculateRAGCorpusSnapshot('old-model', root)
    const state = await writeRAGIndexState(original, { rootPath: root })

    expect(evaluateRAGIndexReadiness(await calculateRAGCorpusSnapshot('new-model', root), state))
      .toMatchObject({ needsReindex: true, reason: 'embedding-model-changed' })
  })
})
