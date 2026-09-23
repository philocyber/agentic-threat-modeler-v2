import type { AnalysisConfig } from '@/lib/models/types'

export type RunSupportingDocument = {
  upload_id: string
  name: string
  type: string
}

export type RunInputBundle = {
  schemaVersion: 1
  runId: string
  systemName: string
  systemId: string | null
  sourceInput: string
  effectiveInput: string
  inputType: 'text' | 'file'
  supportingDocuments: RunSupportingDocument[]
  executionConfig: AnalysisConfig | null
  versionHash: string
}

const SUPPORTING_DOCUMENT_MARKER = '\n\n--- Supporting Document:'

/** Display titles can change; resume/rerun still need the name that was hashed. */
export function fingerprintSystemName(
  artifactName: unknown,
  displayTitle: string | null | undefined,
): string {
  if (typeof artifactName === 'string' && artifactName.trim()) return artifactName.trim()
  return displayTitle?.trim() ?? ''
}

export function inferSourceInput(
  effectiveInput: string,
  supportingDocuments: RunSupportingDocument[],
): string {
  if (supportingDocuments.length === 0) return effectiveInput
  const markerIndex = effectiveInput.indexOf(SUPPORTING_DOCUMENT_MARKER)
  return markerIndex >= 0 ? effectiveInput.slice(0, markerIndex) : effectiveInput
}
