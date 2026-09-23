import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __localHeartbeatPathForTests,
  readWorkerLiveness,
  recordWorkerLiveness,
} from '@/lib/pipeline/worker-liveness'
import { PIPELINE_WORKER_STALE_MS } from '@/lib/pipeline/lease'

const originalRoot = process.env.AGENTICTM_WORKSPACE_ROOT
const originalDatabase = process.env.DATABASE_URL
let testRoot: string | undefined

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
  if (originalRoot === undefined) delete process.env.AGENTICTM_WORKSPACE_ROOT
  else process.env.AGENTICTM_WORKSPACE_ROOT = originalRoot
  if (originalDatabase === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDatabase
})

describe('pipeline worker liveness', () => {
  it('treats a fresh heartbeat file as up and a stale or corrupt file as down', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-liveness-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    delete process.env.DATABASE_URL

    expect(await readWorkerLiveness()).toMatchObject({ status: 'down', lastSeenAt: null })
    await recordWorkerLiveness('worker-test')
    const live = await readWorkerLiveness()
    expect(live.status).toBe('up')
    expect(live.lastSeenAt).toBeTruthy()
    expect(live.instanceId).toBe('worker-test')

    await writeFile(__localHeartbeatPathForTests(), '{"instanceId":"x"}', 'utf8')
    expect(await readWorkerLiveness()).toMatchObject({ status: 'down', lastSeenAt: null })

    await writeFile(
      __localHeartbeatPathForTests(),
      JSON.stringify({ instanceId: 'worker-test', at: Date.now() - PIPELINE_WORKER_STALE_MS - 1, pid: 1 }),
      'utf8',
    )
    const stale = await readWorkerLiveness()
    expect(stale.status).toBe('down')
    expect(stale.lastSeenAt).toBeTruthy()
  })
})
