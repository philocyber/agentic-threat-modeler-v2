/** Live, synthetic data extraction through production adapters. Not scan acceptance. */
import { config as loadEnv } from 'dotenv'
import { z } from 'zod'
import { getConfig, getModelForProviderRole } from '../lib/config'
import { getLLM } from '../lib/llm/factory'
import { invokeStructured } from '../lib/llm/structured'
import { runWithModelCallLimit } from '../lib/llm/call-accounting'
import { emptyUsage, runWithUsage } from '../lib/llm/usage'
import { acceptanceDiagnostic, withResponseCacheDisabled, writeAcceptanceReport } from '../lib/evaluation/acceptance-lifecycle'

const schema = z.object({
  items: z.array(z.object({ name: z.string(), sourceId: z.string(), owner: z.string().nullable() })),
})
const source = '[SRC-001] Atlas is owned by Ana.\n[SRC-002] Birch has no documented owner.'

async function main() {
  loadEnv({ path: '.env.local', quiet: true })
  loadEnv({ quiet: true })
  const base = getConfig()
  const output = `output/qa/provider-data-acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  const results: unknown[] = []
  let passed = true
  for (const provider of ['ollama', 'kimi', 'cursor'] as const) {
    const config = { ...base, llm: { ...base.llm, provider } }
    const tested = new Set<string>()
    for (const role of ['quick', 'deep'] as const) {
      const model = getModelForProviderRole(provider, role, config)
      if (tested.has(model)) continue
      tested.add(model)
      const started = Date.now()
      const usage = emptyUsage()
      const limit = { maxCalls: 1, started: 0 }
      try {
        const value = await withResponseCacheDisabled(() => runWithUsage(usage, () =>
          runWithModelCallLimit(limit, () => invokeStructured({
            llm: getLLM(config, role), schema,
            systemPrompt: 'Extract the two named items in source order. Copy their names and source IDs exactly. Use null for an undocumented owner. Do not invent facts.',
            userMessage: source, agentName: 'SyntheticDataAcceptance', timeoutMs: 90_000,
          }))))
        const valid = JSON.stringify(value) === JSON.stringify({ items: [
          { name: 'Atlas', sourceId: 'SRC-001', owner: 'Ana' },
          { name: 'Birch', sourceId: 'SRC-002', owner: null },
        ] })
        // Compare fields, independent of JSON property ordering.
        const exact = valid || (value.items.length === 2 &&
          value.items[0]?.name === 'Atlas' && value.items[0]?.sourceId === 'SRC-001' && value.items[0]?.owner === 'Ana' &&
          value.items[1]?.name === 'Birch' && value.items[1]?.sourceId === 'SRC-002' && value.items[1]?.owner === null)
        passed &&= exact
        results.push({ provider, role, model, passed: exact, value, usage, attemptedCalls: limit.started, durationMs: Date.now() - started })
        console.log(`${provider}/${model}: ${exact ? 'passed' : 'content mismatch'}`)
      } catch (error) {
        passed = false
        results.push({ provider, role, model, passed: false, diagnostic: acceptanceDiagnostic(error), usage, attemptedCalls: limit.started, durationMs: Date.now() - started })
        console.log(`${provider}/${model}: failed (see report)`)
      }
      await writeAcceptanceReport(output, { scope: 'synthetic-data-extraction-only', status: 'running', passed: false, results })
    }
  }
  await writeAcceptanceReport(output, { scope: 'synthetic-data-extraction-only', status: 'completed', passed, results })
  console.log(`Evidence: ${output}`)
  process.exitCode = passed ? 0 : 1
}

main().catch(error => { console.error(acceptanceDiagnostic(error)); process.exitCode = 1 })
