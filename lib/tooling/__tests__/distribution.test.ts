import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { packageSource } from '../../../scripts/package-source.mjs'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'source-package-test-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(join(source, 'app'), { recursive: true })
  await writeFile(join(source, 'source-distribution.json'), JSON.stringify({ directories: ['app'], files: ['.env.example'], excludedDirectories: [], excludedPaths: [] }))
  return { root, source }
}
it('copies allowlisted code but excludes private files and refuses overwrite', async () => {
  const { root, source } = await fixture()
  await writeFile(join(source, 'app/page.tsx'), 'synthetic code')
  await writeFile(join(source, 'app/.env.local'), 'PRIVATE_FIXTURE')
  await writeFile(join(source, '.env.example'), 'EXAMPLE=')
  await mkdir(join(source, 'data'))
  await writeFile(join(source, 'data/private.txt'), 'PRIVATE_FIXTURE')
  const destination = join(root, 'delivery')
  await packageSource(destination, source)
  const manifest = JSON.parse(await readFile(join(destination, 'DISTRIBUTION-MANIFEST.json'), 'utf8'))
  expect(manifest.files).toEqual(['.env.example', 'app/page.tsx'])
  await expect(packageSource(destination, source)).rejects.toThrow()
})
it('rejects symlink escapes, including allowlisted directory roots', async () => {
  const { root, source } = await fixture()
  await rm(join(source, 'app'), { recursive: true })
  await symlink(root, join(source, 'app'))
  await expect(packageSource(join(root, 'delivery'), source)).rejects.toThrow('Symlinks require explicit review')
})
