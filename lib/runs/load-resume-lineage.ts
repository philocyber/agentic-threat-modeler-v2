import { assembleResumeLineage, type ResumeLineage } from '@/lib/runs/resume-lineage'
import { getThreatModel } from '@/lib/storage/threat-models'
import { readWorkspaceText } from '@/lib/workspace/artifacts'
import type { LocalProject } from '@/lib/workspace/local-project'

export async function loadResumeLineageForRun(input: {
  workspace: LocalProject | null
  runId: string
  metadataResumeFrom?: string
  thisRunSeconds: number | null
  thisRunTokens: number | null
}): Promise<ResumeLineage | null> {
  let manifest: unknown
  let telemetryText = ''
  if (input.workspace) {
    const [manifestResult, telemetryResult] = await Promise.allSettled([
      readWorkspaceText(input.workspace, `runs/${input.runId}/run.json`),
      readWorkspaceText(input.workspace, `runs/${input.runId}/telemetry.jsonl`),
    ])
    if (manifestResult.status === 'fulfilled') {
      try {
        manifest = JSON.parse(manifestResult.value) as unknown
      } catch {
        manifest = undefined
      }
    }
    if (telemetryResult.status === 'fulfilled') telemetryText = telemetryResult.value
  }

  const hint =
    input.metadataResumeFrom ??
    (manifest && typeof manifest === 'object'
      ? (manifest as { resume?: { from?: string } }).resume?.from
      : undefined)
  const source = hint ? await getThreatModel(hint) : null

  return assembleResumeLineage({
    ...(input.metadataResumeFrom ? { metadataResumeFrom: input.metadataResumeFrom } : {}),
    ...(manifest ? { manifest } : {}),
    telemetryText,
    thisRunSeconds: input.thisRunSeconds ?? 0,
    thisRunTokens: input.thisRunTokens ?? 0,
    inheritedSeconds: source?.executionTimeSeconds ?? null,
    inheritedTokens: source?.llmTokensUsed ?? null,
  })
}
