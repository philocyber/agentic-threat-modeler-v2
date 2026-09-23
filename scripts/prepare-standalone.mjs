import { createRequire } from 'node:module'
import { nodeFileTrace } from '@vercel/nft'
import { cp, mkdir, realpath, lstat, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { resolve, dirname, join, relative, sep } from 'node:path'

const root = process.cwd()
const target = resolve('.next/standalone')
// Next's trace may copy development dotenv inputs. Runtime configuration is
// provided by the operator; never distribute local credentials with this build.
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local', '.env.test', '.env.test.local']) {
  await rm(join(target, name), { force: true })
}
// pdf-parse loads its native canvas via a computed require, which tracing
// cannot infer. Seed the actual installed dependency link and worker explicitly.
const require = createRequire(import.meta.url)
const pdfEntry = require.resolve('pdf-parse')
const pdfRoot = resolve(dirname(pdfEntry), '../../..')
const canvasLink = join(dirname(pdfRoot), '@napi-rs/canvas')
createRequire(pdfEntry)('@napi-rs/canvas') // Fail if this platform's native binary cannot load.
const sqliteProbe = new (require('better-sqlite3'))(':memory:')
sqliteProbe.prepare('SELECT 1').get()
sqliteProbe.close()
const traceSeed = resolve('build/pdf-runtime-trace.cjs')
// Cursor's prebundled dynamic loader is not statically traceable. Ship that
// package intact and trace its declared dependencies from its installed layout.
const cursorEntry = require.resolve('@cursor/sdk')
const cursorRoot = resolve(dirname(cursorEntry), '../..')
const cursorTraceRoot = relative(root, cursorRoot).replaceAll('\\', '/')
const cursorManifest = JSON.parse(await readFile(join(cursorRoot, 'package.json'), 'utf8'))
const cursorModules = resolve(cursorRoot, '../..')
const wholePackages = [cursorRoot]
const extraSeeds = []
const runtimeLinks = []
for (const name of Object.keys(cursorManifest.dependencies ?? {})) {
  const link = join(cursorModules, name)
  extraSeeds.push(link)
  wholePackages.push(await realpath(link))
}
for (const name of Object.keys(cursorManifest.optionalDependencies ?? {})) {
  const link = join(cursorModules, name)
  if (!(await lstat(link).catch(() => null))) continue
  wholePackages.push(await realpath(link))
  extraSeeds.push(join(link, 'package.json'))
}
// PDFKit imports several dependencies from its pnpm package layout at runtime.
// Next's web trace can omit them because PDF generation is behind an API route.
const pdfkitEntry = require.resolve('@react-pdf/pdfkit', { paths: [require.resolve('@react-pdf/renderer')] })
const pdfkitRoot = resolve(dirname(pdfkitEntry), '..')
const pdfkitManifest = JSON.parse(await readFile(join(pdfkitRoot, 'package.json'), 'utf8'))
const pdfkitModules = resolve(pdfkitRoot, '../..')
for (const name of Object.keys(pdfkitManifest.dependencies ?? {})) {
  const link = join(pdfkitModules, name)
  runtimeLinks.push(link)
  wholePackages.push(await realpath(link))
}
// Sharp's platform binary is optional in its manifest, so the web trace can
// copy sharp while omitting the installed Windows binding and its shared libs.
const sharpRoot = resolve(dirname(require.resolve('sharp')), '..')
const sharpManifest = JSON.parse(await readFile(join(sharpRoot, 'package.json'), 'utf8'))
const sharpModules = resolve(sharpRoot, '..')
wholePackages.push(sharpRoot)
for (const name of [...Object.keys(sharpManifest.dependencies ?? {}), ...Object.keys(sharpManifest.optionalDependencies ?? {})]) {
  const link = join(sharpModules, name)
  if (!(await lstat(link).catch(() => null))) continue
  runtimeLinks.push(link)
  wholePackages.push(await realpath(link))
}
await writeFile(traceSeed, [canvasLink, ...extraSeeds]
  .map(path => `require(${JSON.stringify('../' + relative(root, path))})`).join('\n') + '\n')
const { fileList, warnings } = await nodeFileTrace(
  ['build/index-knowledge-base.cjs', 'build/pipeline-worker.cjs', relative(root, traceSeed)],
  {
    base: root, processCwd: root,
    ignore: path => path.split('/').some(part => part.startsWith('.env'))
      || path.replaceAll('\\', '/').startsWith(cursorTraceRoot + '/'),
  },
)
fileList.add(relative(root, join(dirname(pdfEntry), 'pdf.worker.mjs')))
let optionalWarnings = 0
for (const warning of warnings) {
  const dependency = warning.message.split('\n')[0].replaceAll('\\', '/')
  if (/"(?:@napi-rs\/canvas[^" ]*|\.\/skia\.[^" ]*|@chroma-core\/default-embed)"/.test(dependency)
    || /better-sqlite3\/build\/(?:Debug|Release)\/better_sqlite3\.node"/.test(dependency)) optionalWarnings++
  else throw warning
}
if (optionalWarnings) console.log(`Runtime trace: ${optionalWarnings} optional platform/embedding integrations or native fallback paths omitted; current canvas and SQLite loaded successfully.`)
for (const file of fileList) {
  if (file.startsWith('../') || file.split('/').some(p => p.startsWith('.env'))) throw new Error(`Unexpected traced path: ${file}`)
  const source = join(root, file)
  const destination = join(target, file)
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    // Preserve pnpm's relative links; resolve their targets inside this package.
    await mkdir(dirname(destination), { recursive: true })
    if (process.platform === 'win32') {
      // fs.cp recreates directory links as file links on Windows, which cannot
      // be followed by Node's module resolver. Junctions retain directory type.
      const linkedRoot = await realpath(source)
      const linkedPath = relative(root, linkedRoot)
      if (linkedPath.startsWith('..')) throw new Error(`Runtime link outside project: ${linkedPath}`)
      const existing = await lstat(destination).catch(() => null)
      if (existing?.isSymbolicLink()) await rm(destination, { force: true })
      else if (existing) throw new Error(`Cannot replace runtime link: ${destination}`)
      await symlink(join(target, linkedPath), destination, 'junction')
    } else {
      await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true, force: false })
    }
  } else {
    await mkdir(dirname(destination), { recursive: true })
    await cp(await realpath(source), destination, { force: true })
  }
}
for (const packageRoot of wholePackages) {
  const path = relative(root, packageRoot)
  if (path.startsWith('../')) throw new Error(`Runtime package outside project: ${path}`)
  await cp(packageRoot, join(target, path), { recursive: true, force: true })
}
for (const link of runtimeLinks) {
  const path = relative(root, link)
  if (path.startsWith('..')) throw new Error(`Runtime link outside project: ${path}`)
  const destination = join(target, path)
  if (await lstat(destination).catch(() => null)) continue
  await mkdir(dirname(destination), { recursive: true })
  const linkedRoot = await realpath(link)
  const linkedPath = relative(root, linkedRoot)
  if (linkedPath.startsWith('..')) throw new Error(`Runtime link target outside project: ${linkedPath}`)
  if (process.platform === 'win32') await symlink(join(target, linkedPath), destination, 'junction')
  else await symlink(await readlink(link), destination)
}
if (process.platform === 'win32') {
  // Next's own standalone copy also emits file-typed pnpm directory symlinks.
  // Convert every packaged directory link before Node resolves the server.
  async function fixDirectoryLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { await fixDirectoryLinks(path); continue }
      if (!entry.isSymbolicLink()) continue
      const linkedPath = resolve(dirname(path), await readlink(path))
      if (relative(target, linkedPath).startsWith('..')) throw new Error(`Runtime link outside package: ${path}`)
      if (!(await stat(linkedPath).catch(() => null))?.isDirectory()) continue
      await rm(path, { force: true })
      await symlink(linkedPath, path, 'junction')
    }
  }
  await fixDirectoryLinks(join(target, 'node_modules'))
}
const packagedRequire = createRequire(join(target, 'package.json'))
const packagedCursor = packagedRequire.resolve('@cursor/sdk')
if (!packagedCursor.startsWith(target + sep)) throw new Error('Cursor SDK is missing from the standalone package')
const cursorRequire = createRequire(packagedCursor)
for (const name of Object.keys(cursorManifest.dependencies ?? {})) {
  if (!cursorRequire.resolve(name).startsWith(target + sep)) throw new Error(`Standalone Cursor dependency is missing: ${name}`)
}
if (typeof packagedRequire('@cursor/sdk').Agent?.prompt !== 'function') throw new Error('Standalone Cursor SDK failed to load')
const packagedSqliteProbe = new (packagedRequire('better-sqlite3'))(':memory:')
packagedSqliteProbe.prepare('SELECT 1').get()
packagedSqliteProbe.close()
for (const [source, destination] of [
  ['drizzle/sqlite', 'drizzle/sqlite'],
  ['public', 'public'],
  ['.next/static', '.next/static'],
]) {
  await cp(resolve(source), join(target, destination), { recursive: true, force: true })
}
console.log('Standalone runtime includes the indexer, SQLite migrations and web assets.')
