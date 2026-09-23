import { cp, mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises'
import { resolve, relative, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function packageSource(destination, sourceRoot = process.cwd()) {
  const root = resolve(sourceRoot)
  const target = resolve(destination)
  if (target === root || root.startsWith(`${target}${sep}`)) throw new Error('The destination must not contain the source tree.')
  const manifest = JSON.parse(await readFile(join(root, 'source-distribution.json'), 'utf8'))
  if (target.startsWith(`${root}${sep}`) && !target.startsWith(`${root}${sep}output${sep}`)) {
    throw new Error('Use an external destination or a new directory under output/.')
  }
  await mkdir(target, { recursive: false }) // Never merge into or overwrite an existing destination.
  const included = []
  const shouldSkip = (path) => {
    const parts = path.split('/')
    const name = parts.at(-1)
    return manifest.excludedDirectories.some(d => parts.includes(d))
      || manifest.excludedPaths.some(p => path === p || path.startsWith(`${p}/`))
      || name === '.DS_Store' || name.endsWith('.log') || name.endsWith('.tsbuildinfo')
      || (name.startsWith('.env') && path !== '.env.example')
  }
  async function copy(path, optional = false) {
    if (shouldSkip(path)) return
    const absolute = join(root, path)
    let info
    try { info = await lstat(absolute) } catch (error) {
      if (optional && error.code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink()) throw new Error(`Symlinks require explicit review: ${path}`)
    if (info.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error(`Symlinks require explicit review: ${path}/${entry.name}`)
        await copy(`${path}/${entry.name}`)
      }
    } else if (info.isFile()) {
      await mkdir(join(target, path, '..'), { recursive: true })
      await cp(absolute, join(target, path), { errorOnExist: true, force: false })
      included.push(path)
    }
  }
  for (const directory of manifest.directories) await copy(directory)
  for (const path of manifest.files) await copy(path, true)
  await writeFile(join(target, 'DISTRIBUTION-MANIFEST.json'), `${JSON.stringify({ format: 1, files: included.sort() }, null, 2)}\n`)
  return { directory: target, files: included.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2]
  if (!destination) {
    console.error('Usage: pnpm package:source /absolute/path/to/new-directory')
    process.exitCode = 1
  } else {
    packageSource(destination).then(result => console.log(`Source distribution: ${result.files} files in ${relative(process.cwd(), result.directory) || result.directory}`))
      .catch(error => { console.error(error.message); process.exitCode = 1 })
  }
}
