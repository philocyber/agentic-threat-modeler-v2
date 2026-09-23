#!/usr/bin/env tsx
/**
 * Smoke-test Kimi / Moonshot credentials from the CLI.
 *
 *   MOONSHOT_API_KEY=... pnpm tsx scripts/test-kimi.ts
 *   # or with .env.local loaded:
 *   pnpm tsx scripts/test-kimi.ts
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
config() // fallback .env

// getConfig() requires DATABASE_URL even for LLM-only smoke tests
process.env.DATABASE_URL ??= 'postgresql://postgres:password@localhost:5432/agentic-tm'
process.env.LLM_PROVIDER = 'kimi'

import { clearConfigCache, getConfig } from '../lib/config'
import { checkProviderKey } from '../lib/llm/check-key'

async function main() {
  clearConfigCache()
  const appConfig = getConfig()

  console.log('🔍 Testing Kimi / Moonshot credentials')
  console.log(`Base URL: ${appConfig.llm.kimiBaseUrl}`)
  console.log(`Quick model: ${appConfig.llm.kimiQuickModel}\n`)

  const result = await checkProviderKey('kimi', appConfig)
  console.log(result.ok ? '✅' : '❌', result.summary)
  if (result.details) console.log('\n' + result.details)
  if (result.hints.length) {
    console.log('\nHints:')
    for (const h of result.hints) console.log(' -', h)
  }
  process.exit(result.ok ? 0 : 1)
}

main().catch((err) => {
  console.error('❌', err)
  process.exit(1)
})
