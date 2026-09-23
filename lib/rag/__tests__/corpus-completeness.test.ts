import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { clearGlobalCorpusCache, loadGlobalCorpusDocuments } from '../global-corpus'

const roots: string[] = []
afterEach(async () => {
  clearGlobalCorpusCache()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rag-completeness-'))
  roots.push(root)
  await mkdir(join(root, 'corporate'))
  return root
}
it('loads every supported corporate file beyond the old 500-file cutoff', async () => {
  const root = await fixture()
  await Promise.all(Array.from({ length: 501 }, (_, i) => writeFile(join(root, 'corporate', `${i}.md`), `# Policy ${i}\nSource text ${i}`)))
  const documents = await loadGlobalCorpusDocuments('corporate', root)
  expect(documents).toHaveLength(501)
  expect(new Set(documents.map(doc => doc.path)).size).toBe(501)
})
it('fails the corpus instead of silently skipping an empty source', async () => {
  const root = await fixture()
  await writeFile(join(root, 'corporate', 'valid.md'), '# Valid\nPolicy')
  await writeFile(join(root, 'corporate', 'empty.md'), '   ')
  await expect(loadGlobalCorpusDocuments('corporate', root)).rejects.toThrow('Cannot load corpus document empty.md')
})
