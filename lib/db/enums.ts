export const ANALYSIS_STATUSES = [
  'pending',
  'running',
  'completed',
  'partial',
  'failed',
] as const

export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number]

/** Events persisted in audit_logs. Operational telemetry must not be added here. */
export const AUDIT_EVENT_TYPES = [
  'analysis_requested',
  'analysis_completed',
  'analysis_failed',
  'analysis_archived',
  'analysis_restored',
  'analysis_deleted',
  'threat_justified',
  'threat_dismissed',
  'threat_confirmed',
  'threat_comment_added',
  'threat_review_updated',
  'rag_index_updated',
  'reviewer_learning_applied',
] as const

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]
