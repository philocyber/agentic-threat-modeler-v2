#!/usr/bin/env tsx
/**
 * Smoke-test AWS Bedrock credentials from the CLI.
 *
 *   BEDROCK_AWS_REGION=us-east-1 \
 *   BEDROCK_AWS_ACCESS_KEY_ID=... \
 *   BEDROCK_AWS_SECRET_ACCESS_KEY=... \
 *   pnpm tsx scripts/test-bedrock.ts
 *
 * Or rely on .env.local / default AWS credential chain.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
config()

process.env.DATABASE_URL ??= 'postgresql://postgres:password@localhost:5432/agentic-tm'
process.env.LLM_PROVIDER = 'bedrock'

import { clearConfigCache, getConfig } from '../lib/config'
import { checkProviderKey } from '../lib/llm/check-key'

async function main() {
  clearConfigCache()
  const appConfig = getConfig()

  console.log('🔍 Testing AWS Bedrock credentials')
  console.log(`Region: ${appConfig.llm.bedrockRegion}`)
  console.log(`Quick model: ${appConfig.llm.bedrockQuickModel}`)
  if (appConfig.llm.bedrockInferenceProfile) {
    console.log(`Inference profile: ${appConfig.llm.bedrockInferenceProfile}`)
  }
  console.log()

  const result = await checkProviderKey('bedrock', appConfig)
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
