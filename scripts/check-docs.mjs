import { readdir, readFile, access } from 'node:fs/promises'
import { resolve, dirname, extname } from 'node:path'
const root = process.cwd()
const errors = []
async function check(file) {
  const text = await readFile(file, 'utf8')
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = match[1].replace(/^<|>$/g, '').split(/\s+"/)[0]
    if (/^(?:https?:|mailto:|#|app:|codex:)/.test(link)) continue
    const path = decodeURIComponent(link.split('#')[0])
    if (!path) continue
    try { await access(resolve(dirname(file), path)) }
    catch { errors.push(`${file}: missing ${path}`) }
  }
}
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'archive') continue
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (extname(path) === '.md') await check(path)
  }
}
await walk(resolve(root, 'docs'))
for (const file of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'PROJECT_STATUS.md', 'knowledge_base/README.md']) await check(resolve(root, file))
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
else console.log('Current documentation links resolve; historical archive excluded.')
