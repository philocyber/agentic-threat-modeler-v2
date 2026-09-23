#!/usr/bin/env tsx
/**
 * Smoke-test Cursor SDK credentials from the CLI.
 *
 *   CURSOR_API_KEY=... pnpm tsx scripts/test-cursor.ts
 *   # or with .env.local loaded:
 *   pnpm tsx scripts/test-cursor.ts
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
config()

process.env.DATABASE_URL ??= 'postgresql://postgres:password@localhost:5432/agentic-tm'
process.env.LLM_PROVIDER = 'cursor'

import { clearConfigCache, getConfig } from '../lib/config'
import { checkProviderKey } from '../lib/llm/check-key'

async function main() {
  clearConfigCache()
  const appConfig = getConfig()

  console.log('🔍 Testing Cursor SDK credentials')
  console.log(`Quick model: ${appConfig.llm.cursorQuickModel}`)
  console.log(`Deep model: ${appConfig.llm.cursorDeepModel}\n`)

  const result = await checkProviderKey('cursor', appConfig)
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
