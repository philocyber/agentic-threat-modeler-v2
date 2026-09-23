import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { clearConfigCache } from '@/lib/config'
import { listKnowledgeFiles } from '@/lib/rag/knowledge-files'
import { calculateRAGCorpusSnapshot, getRAGIndexReadiness, writeRAGIndexState } from '@/lib/rag/index-state'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  clearConfigCache()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('uses the configured external corpus consistently, including legacy technical folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-corpus-'))
  roots.push(root)
  for (const directory of ['technical', 'research', 'corporate']) {
    await mkdir(join(root, directory))
    await writeFile(join(root, directory, 'synthetic.md'), '# Synthetic evidence\nAuthorization is required.')
  }
  vi.stubEnv('KNOWLEDGE_BASE_PATH', root)
  clearConfigCache()
  const files = await listKnowledgeFiles()
  expect(files.map(f => f.path).sort()).toEqual(['corporate/synthetic.md', 'research/synthetic.md', 'technical/synthetic.md'])
  expect(files.filter(f => f.domain === 'technical')).toHaveLength(2)
  const snapshot = await calculateRAGCorpusSnapshot('test-model')
  expect(snapshot.sourceCount).toBe(files.length)
  await writeFile(join(root, 'corporate/unsupported.pdf'), 'Synthetic unsupported corporate input')
  expect((await calculateRAGCorpusSnapshot('test-model')).fingerprint).toBe(snapshot.fingerprint)
  await writeRAGIndexState(snapshot)
  expect((await getRAGIndexReadiness('test-model')).readiness.reason).toBe('up-to-date')
  await writeFile(join(root, 'research/synthetic.md'), '# Changed evidence\nNew authorization guidance.')
  expect((await getRAGIndexReadiness('test-model')).readiness.reason).toBe('knowledge-files-changed')
  const other = await mkdtemp(join(tmpdir(), 'unrelated-corpus-'))
  roots.push(other)
  expect((await getRAGIndexReadiness('test-model', other)).readiness.reason).toBe('no-source-files')
})
