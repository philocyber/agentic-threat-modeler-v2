import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const scanner = process.argv[2] || 'gitleaks'
const root = await mkdtemp(join(tmpdir(), 'agentictm-secret-canary-'))
try {
  // Assemble a nonfunctional detector fixture only in temporary storage.
  const token = ['gh', 'p_', 'Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0Uv9Wx8'].join('')
  for (const path of ['lib/example.ts', 'lib/example/__tests__/fixture.ts', '.cursor/rules/example.md']) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), `const token = "${token}"\n`)
  }
  const report = join(root, 'findings.json')
  const run = spawnSync(scanner, ['dir', root, '--config', resolve('.gitleaks.toml'), '--redact', '--no-banner', '--report-format', 'json', '--report-path', report], { stdio: 'ignore' })
  if (run.status !== 1) throw new Error('Secret detector canary failed: expected findings.')
  const { readFile } = await import('node:fs/promises')
  const findings = JSON.parse(await readFile(report, 'utf8'))
  for (const path of ['lib/example.ts', 'lib/example/__tests__/fixture.ts', '.cursor/rules/example.md']) {
    if (!findings.some(f => f.File.endsWith(path))) throw new Error(`Canary was not detected in ${path}`)
  }
  console.log('Secret scanner detects synthetic tokens in source, tests and editor rules.')
} finally { await rm(root, { recursive: true, force: true }) }
