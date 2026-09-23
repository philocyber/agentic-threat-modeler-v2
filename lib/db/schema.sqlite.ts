import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const systems = sqliteTable('systems', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index('idx_systems_name').on(table.name),
  index('idx_systems_created_at').on(table.createdAt),
])

export const threatModels = sqliteTable('threat_models', {
  id: text('id').primaryKey(),
  systemId: text('system_id').references(() => systems.id, { onDelete: 'set null' }),
  title: text('title'),
  input: text('input').notNull(),
  supportingDocuments: text('supporting_documents', { mode: 'json' }).$type<
    Array<{ upload_id: string; name: string; type: string }> | null
  >(),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  versionHash: text('version_hash').notNull(),
  status: text('status', { enum: ['pending', 'running', 'completed', 'partial', 'failed'] })
    .notNull()
    .default('pending'),
  currentPhase: text('current_phase'),
  errorMessage: text('error_message'),
  cancelRequestedAt: integer('cancel_requested_at', { mode: 'timestamp_ms' }),
  cancelGeneration: integer('cancel_generation').notNull().default(0),
  workerInstanceId: text('worker_instance_id'),
  workerHeartbeatAt: integer('worker_heartbeat_at', { mode: 'timestamp_ms' }),
  leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
  systemDescription: text('system_description'),
  debateSummary: text('debate_summary'),
  methodologiesUsed: text('methodologies_used', { mode: 'json' }).$type<string[] | null>(),
  architectureJson: text('architecture_json', { mode: 'json' }).$type<unknown>(),
  llmTokensUsed: integer('llm_tokens_used'),
  executionTimeSeconds: integer('execution_time_seconds'),
  totalThreats: integer('total_threats'),
  filteredThreats: integer('filtered_threats'),
  externalId: text('external_id'),
  webhookUrl: text('webhook_url'),
  webhookDelivered: integer('webhook_delivered', { mode: 'boolean' }).default(false),
  pipelineErrors: text('pipeline_errors', { mode: 'json' }).$type<string[] | null>(),
  queuedAt: integer('queued_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index('idx_tm_status').on(table.status),
  index('idx_tm_version_hash').on(table.versionHash),
  index('idx_tm_system_id').on(table.systemId),
  index('idx_tm_external_id').on(table.externalId),
  index('idx_tm_created_at').on(table.createdAt),
  index('idx_tm_archived_created_at').on(table.archivedAt, table.createdAt),
  index('idx_tm_cancel_requested').on(table.cancelRequestedAt),
  index('idx_tm_running_heartbeat').on(table.status, table.workerHeartbeatAt),
  index('idx_tm_lease').on(table.status, table.leaseExpiresAt),
])

export const threats = sqliteTable('threats', {
  id: text('id').primaryKey(),
  threatModelId: text('threat_model_id')
    .notNull()
    .references(() => threatModels.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull(),
  component: text('component'),
  strideCategory: text('stride_category'),
  pastaPhase: text('pasta_phase'),
  methodology: text('methodology'),
  dreadDamage: integer('dread_damage'),
  dreadReproducibility: integer('dread_reproducibility'),
  dreadExploitability: integer('dread_exploitability'),
  dreadAffectedUsers: integer('dread_affected_users'),
  dreadDiscoverability: integer('dread_discoverability'),
  severity: text('severity', { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }),
  impact: text('impact'),
  mitigation: text('mitigation'),
  controlReference: text('control_reference'),
  attackScenarios: text('attack_scenarios', { mode: 'json' }).$type<string[] | null>(),
  recommendedControls: text('recommended_controls', { mode: 'json' }).$type<string[] | null>(),
  owaspCategories: text('owasp_categories', { mode: 'json' }).$type<string[] | null>(),
  confidenceScore: integer('confidence_score'),
  evidenceSources: text('evidence_sources', { mode: 'json' }).$type<unknown>(),
  reasoning: text('reasoning'),
  methodologyData: text('methodology_data', { mode: 'json' }).$type<{
    attackTree?: {
      rootGoal: string
      tree: unknown
      textRepresentation: string
    }
    attackerProfile?: string
    attackVector?: string
    methodologies?: Array<'STRIDE' | 'PASTA' | 'ATTACK_TREE' | 'DEBATE' | 'SYNTHESIS'>
    scoringStatus?: 'unscored' | 'provisional' | 'validated'
    scoringRationale?: string
    sourceCandidateIds?: string[]
    disposition?: 'applicable' | 'conditional' | 'control_verification_needed' | 'mitigated' | 'invalid'
    preconditions?: string[]
    residualRiskNotes?: string
  } | null>(),
  userComments: text('user_comments'),
  reviewStatus: text('review_status'),
  reviewReason: text('review_reason'),
  reviewNotes: text('review_notes'),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
  traceability: text('traceability', { mode: 'json' }).$type<unknown>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index('idx_threats_tm').on(table.threatModelId),
  index('idx_threats_severity').on(table.severity),
  index('idx_threats_stride').on(table.strideCategory),
  index('idx_threats_review').on(table.reviewStatus),
])

export const uploads = sqliteTable('uploads', {
  id: text('id').primaryKey(),
  originalName: text('original_name').notNull(),
  mediaType: text('media_type').notNull(),
  content: text('content').notNull(),
  size: integer('size').notNull(),
  relativePath: text('relative_path'),
  sha256: text('sha256'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index('idx_uploads_expires').on(table.expiresAt),
])

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index('idx_audit_logs_event_type').on(table.eventType),
  index('idx_audit_logs_created_at').on(table.createdAt),
])

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => threatModels.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  relativePath: text('relative_path').notNull(),
  mimeType: text('mime_type').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index('idx_artifacts_run_id').on(table.runId),
  uniqueIndex('idx_artifacts_run_kind').on(table.runId, table.kind),
])
