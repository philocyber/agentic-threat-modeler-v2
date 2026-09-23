#!/usr/bin/env tsx

import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'

loadEnv({ path: '.env.local', quiet: true })
loadEnv({ path: '.env', quiet: true })
process.env.AGENTICTM_ENV_FILE ??= resolve('.env.local')

async function main() {
  const { startPipelineWorker } = await import('@/lib/pipeline/worker')
  await startPipelineWorker()
}

main().catch(error => {
  console.error('[pipeline-worker]', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
