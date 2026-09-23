export type ResumeRef = {
  resumeFrom: string
  reusedPhases: number
}

export type ResumeLineage = ResumeRef & {
  thisRunSeconds: number
  inheritedSeconds: number | null
  thisRunTokens: number
  inheritedTokens: number | null
}

const RESUME_LOG = /^Resuming from (tm_[a-z0-9-]+): reusing (\d+) phase\(s\)$/i

export function parseResumeLog(message: string): ResumeRef | null {
  const match = message.trim().match(RESUME_LOG)
  if (!match?.[1]) return null
  return { resumeFrom: match[1], reusedPhases: Number(match[2] ?? 0) }
}

export function parseResumeTelemetry(text: string): ResumeRef | null {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as { message?: unknown }
      if (typeof row.message !== 'string') continue
      const parsed = parseResumeLog(row.message)
      if (parsed) return parsed
    } catch {
      const parsed = parseResumeLog(line)
      if (parsed) return parsed
    }
  }
  return null
}

export function lineageRuntimeSeconds(lineage: ResumeLineage): number {
  return (lineage.inheritedSeconds ?? 0) + lineage.thisRunSeconds
}

export function lineageTokenCount(lineage: ResumeLineage): number {
  return (lineage.inheritedTokens ?? 0) + lineage.thisRunTokens
}

export function resumeRefFromManifest(manifest: unknown): ResumeRef | null {
  if (!manifest || typeof manifest !== 'object') return null
  const resume = (manifest as { resume?: { from?: unknown; reusedPhases?: unknown } }).resume
  if (typeof resume?.from !== 'string' || !resume.from.startsWith('tm_')) return null
  return {
    resumeFrom: resume.from,
    reusedPhases: typeof resume.reusedPhases === 'number' ? resume.reusedPhases : 0,
  }
}

export function assembleResumeLineage(input: {
  metadataResumeFrom?: string
  manifest?: unknown
  telemetryText?: string
  thisRunSeconds: number
  thisRunTokens: number
  inheritedSeconds: number | null
  inheritedTokens: number | null
}): ResumeLineage | null {
  const fromManifest = resumeRefFromManifest(input.manifest)
  const fromTelemetry = parseResumeTelemetry(input.telemetryText ?? '')
  const ref =
    fromManifest ??
    fromTelemetry ??
    (input.metadataResumeFrom
      ? { resumeFrom: input.metadataResumeFrom, reusedPhases: 0 }
      : null)
  if (!ref) return null
  return {
    ...ref,
    reusedPhases: Math.max(ref.reusedPhases, fromTelemetry?.reusedPhases ?? 0, fromManifest?.reusedPhases ?? 0),
    thisRunSeconds: input.thisRunSeconds,
    thisRunTokens: input.thisRunTokens,
    inheritedSeconds: input.inheritedSeconds,
    inheritedTokens: input.inheritedTokens,
  }
}
