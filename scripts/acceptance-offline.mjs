import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// This command deliberately selects only deterministic suites, never live-provider tests.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const suites = [
  'lib/pipeline/__tests__/acceptance-workflow.test.ts',
  'lib/evaluation/__tests__/stage2-acceptance.test.ts',
  'lib/evaluation/__tests__/acceptance-lifecycle.test.ts',
  'lib/llm/__tests__/provider-wire.test.ts',
  'lib/llm/__tests__/call-accounting.test.ts',
  'lib/llm/__tests__/execution-profiles.test.ts',
  'lib/llm/__tests__/cancellable-ollama.test.ts',
]
const startedAt = new Date().toISOString()
const output = resolve(root, process.env.ACCEPTANCE_OUTPUT_DIR || `output/qa/offline-acceptance/${startedAt.replace(/[:.]/g, '-')}`)
await mkdir(output, { recursive: true })
const reportPath = resolve(output, 'tests.json')
const summaryPath = resolve(output, 'summary.json')
const base = { scope: 'offline-workflow-contracts', liveModelQuality: 'not-tested', startedAt, suites }
await writeFile(summaryPath, JSON.stringify({ ...base, status: 'running', passed: false }, null, 2))

// Missing suites must fail, rather than silently reducing the advertised scope.
try {
  await Promise.all(suites.map(file => readFile(resolve(root, file))))
  const child = spawn(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', ...suites,
    '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`,
  ], { cwd: root, stdio: 'inherit', detached: process.platform !== 'win32' })
  let timedOut = false
  let interrupted = false
  let forceKill
  const kill = signal => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const stop = () => {
    kill('SIGTERM')
    forceKill ??= setTimeout(() => kill('SIGKILL'), 5_000)
  }
  const interrupt = () => { interrupted = true; stop() }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const deadline = setTimeout(() => { timedOut = true; stop() }, 120_000)
  const result = await new Promise((resolveResult) => {
    child.once('error', error => resolveResult({ code: null, error: error.message }))
    child.once('close', (code, signal) => resolveResult({ code, signal }))
  })
  clearTimeout(deadline)
  clearTimeout(forceKill)
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  let report
  try { report = JSON.parse(await readFile(reportPath, 'utf8')) } catch { /* missing report fails closed */ }
  const missingSuites = suites.filter(suite => !report?.testResults?.some(result => result.name === resolve(root, suite)))
  const passed = !timedOut && !interrupted && result.code === 0 && report?.success === true
    && report.numTotalTests > 0 && report.numPassedTests === report.numTotalTests && missingSuites.length === 0
  await writeFile(summaryPath, JSON.stringify({
    ...base, finishedAt: new Date().toISOString(), passed,
    status: timedOut ? 'timed-out' : interrupted ? 'interrupted' : passed ? 'passed' : 'failed',
    process: result, missingSuites, totalTests: report?.numTotalTests ?? 0,
    passedTests: report?.numPassedTests ?? 0, reportPath,
  }, null, 2))
  console.log(`Acceptance evidence: ${summaryPath}`)
  process.exitCode = passed ? 0 : 1
} catch (error) {
  await writeFile(summaryPath, JSON.stringify({ ...base, status: 'failed', passed: false,
    finishedAt: new Date().toISOString(), error: String(error) }, null, 2))
  console.error(`Acceptance failed. Evidence: ${summaryPath}`)
  process.exitCode = 1
}
