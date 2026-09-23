import { describe, expect, it } from 'vitest'
import type { RunInputBundle } from '@/lib/runs/input-bundle'
import { buildRerunRequest } from '@/lib/runs/rerun-request'

const bundle: RunInputBundle = {
  schemaVersion: 1,
  runId: 'tm_partial',
  systemName: 'Example Service',
  systemId: 'sys_example',
  sourceInput: 'Original request',
  effectiveInput: 'Original request\n\n--- Supporting Document: architecture.md (text/markdown) ---\nDetails',
  inputType: 'text',
  supportingDocuments: [
    { upload_id: 'upload_1', name: 'architecture.md', type: 'text/markdown' },
  ],
  executionConfig: {
    provider: 'kimi',
    quickModel: 'kimi-k3',
    deepModel: 'kimi-k3',
    enabledAnalysts: ['stride', 'pasta', 'attack_tree'],
    executionMode: 'hybrid',
    maxDebateRounds: 3,
    targetThreats: 20,
    requireEvidenceForHighPriority: true,
    useRag: true,
  },
  versionHash: 'hash',
}

describe('buildRerunRequest', () => {
  it('keeps checkpoint lineage when resuming a partial or failed run', () => {
    expect(buildRerunRequest(bundle, 'resume')).toMatchObject({
      systemName: bundle.systemName,
      systemId: bundle.systemId,
      input: bundle.effectiveInput,
      config: bundle.executionConfig,
      resumeFrom: bundle.runId,
    })
  })

  it('executes every phase for a fresh rerun', () => {
    const request = buildRerunRequest(bundle, 'fresh')
    expect(request.input).toBe(bundle.effectiveInput)
    expect(request).not.toHaveProperty('resumeFrom')
  })
})
