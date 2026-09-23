import { describe, expect, it } from 'vitest'
import { workerCompatibility, workerCodeVersionOf, tagWorkerInstanceId } from '../worker-version'
import { PIPELINE_WORKER_CODE_VERSION } from '@/lib/contracts/versions'

describe('pipeline worker compatibility', () => {
  it('treats a live process without the current code version as incompatible', () => {
    const liveId = 'host:1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const old = workerCompatibility({ status: 'up', instanceId: liveId })
    expect(old.compatible).toBe(false)
    expect(old.recovery[0]).toMatch(/pipeline:worker/)
    expect(workerCodeVersionOf(liveId)).toBeNull()
  })

  it('accepts a tagged live worker at the current version', () => {
    const tagged = tagWorkerInstanceId('worker-a')
    expect(workerCodeVersionOf(tagged)).toBe(PIPELINE_WORKER_CODE_VERSION)
    expect(workerCompatibility({ status: 'up', instanceId: tagged }).compatible).toBe(true)
  })

  it('does not treat a missing worker as an incompatible live process', () => {
    expect(workerCompatibility({ status: 'down', instanceId: null }).compatible).toBe(true)
    expect(workerCompatibility({ status: 'down', instanceId: 'legacy-untagged' }).compatible).toBe(true)
  })
})
