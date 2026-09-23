import { describe, expect, it } from 'vitest'
import {
  assembleResumeLineage,
  lineageRuntimeSeconds,
  lineageTokenCount,
  parseResumeLog,
  parseResumeTelemetry,
  resumeRefFromManifest,
} from '@/lib/runs/resume-lineage'

describe('resume lineage', () => {
  it('parses the resume telemetry line', () => {
    expect(parseResumeLog('Resuming from tm_ec48806e-c1e6-4738-82ec-b04a614aac7c: reusing 8 phase(s)')).toEqual({
      resumeFrom: 'tm_ec48806e-c1e6-4738-82ec-b04a614aac7c',
      reusedPhases: 8,
    })
  })

  it('reads resume from jsonl telemetry', () => {
    const text = [
      '{"message":"[pipeline] RAG enabled at http://localhost:8000."}',
      '{"message":"Resuming from tm_ec48806e-c1e6-4738-82ec-b04a614aac7c: reusing 8 phase(s)"}',
    ].join('\n')
    expect(parseResumeTelemetry(text)?.reusedPhases).toBe(8)
  })

  it('adds inherited compute to this attempt', () => {
    expect(
      lineageRuntimeSeconds({
        resumeFrom: 'tm_prior',
        reusedPhases: 8,
        thisRunSeconds: 26,
        inheritedSeconds: 1466,
        thisRunTokens: 2848,
        inheritedTokens: 195289,
      }),
    ).toBe(1492)
    expect(
      lineageTokenCount({
        resumeFrom: 'tm_prior',
        reusedPhases: 8,
        thisRunSeconds: 26,
        inheritedSeconds: 1466,
        thisRunTokens: 2848,
        inheritedTokens: 195289,
      }),
    ).toBe(198137)
  })

  it('reads the run manifest resume block', () => {
    expect(
      resumeRefFromManifest({
        resume: { from: 'tm_ec48806e-c1e6-4738-82ec-b04a614aac7c', reusedPhases: 8 },
      }),
    ).toEqual({
      resumeFrom: 'tm_ec48806e-c1e6-4738-82ec-b04a614aac7c',
      reusedPhases: 8,
    })
  })

  it('assembles lineage from telemetry when the manifest has no resume block', () => {
    const lineage = assembleResumeLineage({
      telemetryText: '{"message":"Resuming from tm_ec48806e-c1e6-4738-82ec-b04a614aac7c: reusing 8 phase(s)"}',
      thisRunSeconds: 26,
      thisRunTokens: 2848,
      inheritedSeconds: 1466,
      inheritedTokens: 195289,
    })
    expect(lineage?.resumeFrom).toBe('tm_ec48806e-c1e6-4738-82ec-b04a614aac7c')
    expect(lineageRuntimeSeconds(lineage!)).toBe(1492)
  })
})
