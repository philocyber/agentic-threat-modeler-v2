import { afterEach, describe, expect, it } from 'vitest'
import { clearConfigCache, getConfig } from '@/lib/config'

const originalEvidenceGate = process.env.PIPELINE_REQUIRE_EVIDENCE_FOR_HIGH_PRIORITY

afterEach(() => {
  if (originalEvidenceGate === undefined) delete process.env.PIPELINE_REQUIRE_EVIDENCE_FOR_HIGH_PRIORITY
  else process.env.PIPELINE_REQUIRE_EVIDENCE_FOR_HIGH_PRIORITY = originalEvidenceGate

  clearConfigCache()
})

describe('environment booleans', () => {
  it('treats string false as false instead of truthy', () => {
    process.env.PIPELINE_REQUIRE_EVIDENCE_FOR_HIGH_PRIORITY = 'false'
    clearConfigCache()

    const config = getConfig()

    expect(config.pipeline.requireEvidenceForHighPriority).toBe(false)
  })

})
