import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  inet,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { ANALYSIS_STATUSES, AUDIT_EVENT_TYPES } from '@/lib/db/enums'
import type { RunManifestV2 } from '@/lib/runs/run-manifest'

// ─── Enums ─────────────────────────────────────────────────────────────────

export const analysisStatusEnum = pgEnum('analysis_status', ANALYSIS_STATUSES)

export const threatPriorityEnum = pgEnum('threat_priority', [
  'critical',
  'high',
  'medium',
  'low',
])

export const invalidReasonEnum = pgEnum('invalid_reason', [
  'hallucination',
  'out_of_scope',
  'low_priority',
  'duplicate',
  'not_applicable',
])

export const threatSeverityEnum = pgEnum('threat_severity', [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
])

export const auditEventTypeEnum = pgEnum('audit_event_type', AUDIT_EVENT_TYPES)

// ─── Types (stored in jsonb) ────────────────────────────────────────────────

export type EvidenceSource = {
  sourceType: 'rag' | 'architecture' | 'debate'
  sourceName: string
  excerpt: string
  citationId?: string | undefined
  queryId?: string | undefined
  chunkId?: string | undefined
  sourceVersion?: string | undefined
  domain?: 'technical' | 'corporate' | 'reviewer' | undefined
  sourceMetadata?: Record<string, unknown> | undefined
  referenceStatus?: 'verified' | 'unverified' | undefined
  supportStatus?: 'supports' | 'unlinked' | undefined
  passageId?: string | undefined
  contentFingerprint?: string | undefined
  relevanceStatus?: 'relevant' | 'not_relevant' | 'insufficient' | undefined
}

export type DreadScore = {
  damage: number
  reproducibility: number
  exploitability: number
  affectedUsers: number
  discoverability: number
  total: number
}

export type AttackTreeNode = {
  goal: string
  type: 'OR' | 'AND' | 'LEAF'
  children?: AttackTreeNode[] | undefined
  notes?: string | undefined
}

export type AttackTreeData = {
  rootGoal: string
  tree: AttackTreeNode
  textRepresentation: string
}

export type UnifiedThreat = {
  id: string
  displayId?: string | undefined  // Human-readable, category-based ID (for example WEB-01)
  title?: string | undefined  // Architectural threat pattern (generic, reusable)
  component: string
  strideCategory?: string | null | undefined
  methodology: 'STRIDE' | 'PASTA' | 'ATTACK_TREE' | 'DEBATE' | 'SYNTHESIS'
  description: string
  impact: string
  mitigation: string
  controlReference?: string | null | undefined
  owaspCategories?: string[] | null | undefined   // e.g. ["A01:2021 – Broken Access Control", "API2:2023 – Broken Authentication"]
  scoringStatus?: 'unscored' | 'provisional' | 'validated' | undefined
  scoringRationale?: string | undefined
  dread: DreadScore
  priority: 'critical' | 'high' | 'medium' | 'low'
  confidenceScore: number
  evidenceSources: EvidenceSource[]  // Source quotations complement architecture traceability.
  reasoning?: string | null | undefined
  methodologies?: Array<'STRIDE' | 'PASTA' | 'ATTACK_TREE' | 'DEBATE' | 'SYNTHESIS'> | undefined
  sourceCandidateIds?: string[] | undefined
  disposition?: 'applicable' | 'conditional' | 'control_verification_needed' | 'mitigated' | 'invalid' | undefined
  preconditions?: string[] | undefined
  residualRiskNotes?: string | undefined
  
  // Traceability to architecture elements (SKILL integration - Phase 2)
  traceability?: {
    trustBoundaries?: string[] | undefined      // ["TB-1", "TB-2"] - Which Trust Boundaries are crossed
    components?: string[] | undefined            // ["Kong Gateway", "Backend API"] - Specific components affected
    endpoints?: string[] | undefined             // ["POST /api/users", "GET /api/me"] - API endpoints vulnerable
    environmentVars?: string[] | undefined       // ["JWT_SECRET", "DATABASE_URL"] - Env vars involved
    securityConfigs?: string[] | undefined       // ["Kong jwt plugin disabled"] - Security configs related
  } | undefined

  // Methodology-specific structured data preserved through synthesis
  attackTree?: AttackTreeData | undefined
  attackerProfile?: string | undefined
  attackVector?: string | undefined
  
  // Review and comment fields (RFC integration)
  userComments?: string | null | undefined
  reviewStatus?: 'pending' | 'confirmed' | 'rejected' | null | undefined
  reviewNotes?: string | null | undefined
  reviewedAt?: string | null | undefined  // ISO timestamp
}

export type ArchitectureData = {
  sourceEvidence?: import('@/lib/architecture/source-evidence').SourceEvidence

  systemDescription: string
  components: Array<{ name: string; type: string; scope: string; technology?: string | undefined; relationship?: 'system' | 'dependency' | 'investigated' | 'adjacent' | 'proposed' | 'historical'; scopeEvidence?: string | undefined }>
  dataFlows: Array<{ from: string; to: string; data: string; protocol?: string | undefined }>
  trustBoundaries: string[]
  externalEntities: string[]
  dataStores: string[]
  apiEndpoints: string[]
  deploymentInfo: string
  mermaidDfd: string
  mermaidArchitectureDiagram?: string | undefined  // Architecture Overview (graph TB with zones/layers)
  techFlags: {
    hasAI: boolean
    hasMicroservices: boolean
    hasKubernetes: boolean
    hasAuthSystem: boolean
    hasExternalIntegrations: boolean
    hasDatabaseLayer: boolean
    hasFileStorage: boolean
    hasMessageQueue: boolean
  }
  // Enhanced topology from SKILL integration
  detailedTopology?: {
    actors?: Array<{
      name: string
      description: string
      privilegeLevel: string  // "admin" | "user" | "public" | "service"
      reference?: string | undefined      // "RFC Section 3.1" or "Page 5, paragraph 2"
    }> | undefined
    environmentVars?: Array<{
      name: string
      value?: string | undefined          // Redacted if sensitive ([REDACTED])
      isSensitive: boolean
      component: string       // Which component uses this var
    }> | undefined
    securityConfigs?: Array<{
      component: string       // "Kong Gateway v3.2", "WAF", "Firewall"
      configType: string      // "plugin" | "firewall" | "iam" | "policy"
      isEnabled: boolean
      details: string         // "jwt validation disabled", "rate-limiting: 100 req/min"
    }> | undefined
  } | undefined
  factLedger?: {
    sourceFacts: Array<{ id: string; text: string; category: 'architecture' | 'data' | 'boundary' | 'control' }>
    controls: Array<{
      id: string
      name: string
      status: 'enabled' | 'disabled' | 'unknown'
      component?: string | undefined
      evidence: string
    }>
    assets: string[]
    assumptions: string[]
  } | undefined
}

export type AnalysisConfig = {
  provider: 'ollama' | 'google' | 'kimi' | 'bedrock' | 'cursor'
  /** Providers explicitly authorized to receive analysis context. */
  allowedProviders?: Array<'ollama' | 'google' | 'kimi' | 'bedrock' | 'cursor'>
  /** Active routing profile for this run. */
  executionProfile?: 'local_efficient' | 'provider_optimized' | 'provider_full_power' | 'adaptive_value'
  /** Profiles a quality gate may use without asking for a new authorization. */
  allowedProfiles?: Array<'local_efficient' | 'provider_optimized' | 'provider_full_power' | 'adaptive_value'>
  // Per-tier model names. quickModel: parser/pasta/attack_tree/validator. deepModel: stride/debate/synthesis.
  quickModel?: string
  deepModel?: string
  enabledAnalysts: ('stride' | 'pasta' | 'attack_tree')[]
  executionMode: 'hybrid' | 'parallel' | 'cascade'
  maxDebateRounds: number
  targetThreats: number
  requireEvidenceForHighPriority: boolean
  /**
   * When false, analysts skip Chroma/RAG tools and work from architecture
   * context only. Defaults to true. The pipeline also skips tools when Chroma
   * is unreachable, even if this flag is true.
   */
  useRag?: boolean
}

export type AnalysisMetadata = {
  demo?: boolean
  source?: string              // 'partner' | 'manual' | 'api'
  rfc_id?: string              // UUID del RFC externo
  rfc_document_id?: string     // UUID del documento
  rfc_version?: number         // Versión numérica del RFC
  project_id?: string          // UUID del proyecto externo
  workflow_execution_id?: string // UUID de ejecución del workflow
  analyzed_at?: string         // ISO timestamp
  version_hash?: string        // SHA-256 (redundante con columna, para facilidad)
  input_type?: 'text' | 'file'
  analysis_config?: AnalysisConfig // Resolved, reproducible routing snapshot
  createdBy?: string
  /** Prior run whose completed phases seeded this one. */
  resumeFrom?: string
  run_manifest?: RunManifestV2
  rag_trace?: import('@/lib/rag/trace').RAGTraceSnapshot
  webhook_secret?: string
}

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: auditEventTypeEnum('event_type').notNull(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_audit_logs_event_type').on(t.eventType),
    index('idx_audit_logs_created_at').on(t.createdAt),
  ]
)

// ─── Tables ─────────────────────────────────────────────────────────────────

export const threatModels = pgTable(
  'threat_models',
  {
    id: varchar('id', { length: 255 }).primaryKey(), // tm_abc123xyz
    systemId: varchar('system_id', { length: 255 }).references(() => systems.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 500 }),
    input: text('input').notNull(),
    supportingDocuments: jsonb('supporting_documents').$type<Array<{ upload_id: string; name: string; type: string }>>(),
    metadata: jsonb('metadata').$type<AnalysisMetadata>(),
    versionHash: varchar('version_hash', { length: 64 }).notNull(),

    // Status tracking
    status: analysisStatusEnum('status').notNull().default('pending'),
    currentPhase: varchar('current_phase', { length: 100 }),
    errorMessage: text('error_message'),
    cancelRequestedAt: timestamp('cancel_requested_at'),
    cancelGeneration: integer('cancel_generation').notNull().default(0),
    workerInstanceId: varchar('worker_instance_id', { length: 128 }),
    workerHeartbeatAt: timestamp('worker_heartbeat_at'),
    leaseExpiresAt: timestamp('lease_expires_at'),

    // Outputs
    systemDescription: text('system_description'),
    debateSummary: text('debate_summary'),
    methodologiesUsed: jsonb('methodologies_used').$type<string[]>(),
    architectureJson: jsonb('architecture_json').$type<ArchitectureData>(),

    // Metrics
    llmTokensUsed: integer('llm_tokens_used'),
    executionTimeSeconds: integer('execution_time_seconds'),
    totalThreats: integer('total_threats'),
    filteredThreats: integer('filtered_threats'),

    // External integrator fields
    externalId: varchar('external_id', { length: 255 }),
    webhookUrl: text('webhook_url'),
    webhookDelivered: boolean('webhook_delivered').default(false),

    // Partial pipeline failures (analyst errors that did not abort the run)
    pipelineErrors: jsonb('pipeline_errors').$type<string[]>(),

    // Timestamps
    queuedAt: timestamp('queued_at').notNull().defaultNow(),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_tm_status').on(t.status),
    index('idx_tm_version_hash').on(t.versionHash),
    index('idx_tm_system_id').on(t.systemId),
    index('idx_tm_external_id').on(t.externalId),
    index('idx_tm_created_at').on(t.createdAt),
    index('idx_tm_archived_created_at').on(t.archivedAt, t.createdAt),
    index('idx_tm_cancel_requested').on(t.cancelRequestedAt),
    index('idx_tm_running_heartbeat').on(t.status, t.workerHeartbeatAt),
    index('idx_tm_lease').on(t.status, t.leaseExpiresAt),
  ]
)

export const systems = pgTable(
  'systems',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    name: varchar('name', { length: 500 }).notNull(),
    description: text('description'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_systems_name').on(t.name),
    index('idx_systems_created_at').on(t.createdAt),
  ],
)

export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    originalName: varchar('original_name', { length: 500 }).notNull(),
    mediaType: varchar('media_type', { length: 100 }).notNull(),
    content: text('content').notNull(),
    size: integer('size').notNull(),
    sha256: varchar('sha256', { length: 64 }),
    ownerPrincipalId: varchar('owner_principal_id', { length: 64 }),
    ownerPrincipalKind: varchar('owner_principal_kind', { length: 20 }),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_uploads_expires').on(t.expiresAt),
    index('idx_uploads_owner').on(t.ownerPrincipalKind, t.ownerPrincipalId),
  ]
)

export const threats = pgTable(
  'threats',
  {
    id: varchar('id', { length: 255 }).primaryKey(), // THR-001
    threatModelId: varchar('threat_model_id', { length: 255 })
      .notNull()
      .references(() => threatModels.id, { onDelete: 'cascade' }),

    // Basic info
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description').notNull(),
    component: varchar('component', { length: 255 }),

    // Methodologies
    strideCategory: varchar('stride_category', { length: 50 }),
    pastaPhase: varchar('pasta_phase', { length: 100 }),
    methodology: varchar('methodology', { length: 50 }), // STRIDE|PASTA|ATTACK_TREE|DEBATE|SYNTHESIS

    // DREAD scoring
    dreadDamage: integer('dread_damage'),
    dreadReproducibility: integer('dread_reproducibility'),
    dreadExploitability: integer('dread_exploitability'),
    dreadAffectedUsers: integer('dread_affected_users'),
    dreadDiscoverability: integer('dread_discoverability'),
    severity: threatSeverityEnum('severity'), // Calculado desde DREAD

    // Additional context
    impact: text('impact'),
    mitigation: text('mitigation'),
    controlReference: varchar('control_reference', { length: 255 }),
    attackScenarios: jsonb('attack_scenarios').$type<string[]>(),
    recommendedControls: jsonb('recommended_controls').$type<string[]>(),
    owaspCategories: jsonb('owasp_categories').$type<string[]>(),
    confidenceScore: integer('confidence_score'), // 0-100
    evidenceSources: jsonb('evidence_sources').$type<EvidenceSource[]>(),
    reasoning: text('reasoning'),
    methodologyData: jsonb('methodology_data').$type<{
      attackTree?: AttackTreeData
      attackerProfile?: string
      attackVector?: string
      methodologies?: UnifiedThreat['methodologies']
      sourceCandidateIds?: string[]
      scoringStatus?: UnifiedThreat['scoringStatus']
      scoringRationale?: string
      disposition?: UnifiedThreat['disposition']
      preconditions?: string[]
      residualRiskNotes?: string
    }>(),

    // Review fields
    userComments: text('user_comments'),
    reviewStatus: varchar('review_status', { length: 20 }), // pending|confirmed|rejected
    reviewReason: varchar('review_reason', { length: 100 }), // hallucination|out_of_scope|etc
    reviewNotes: text('review_notes'),
    reviewedAt: timestamp('reviewed_at'),

    // Traceability (SKILL integration - Phase 2)
    traceability: jsonb('traceability').$type<{
      trustBoundaries?: string[] | undefined
      components?: string[] | undefined
      endpoints?: string[] | undefined
      environmentVars?: string[] | undefined
      securityConfigs?: string[] | undefined
    }>(),

    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_threats_tm').on(t.threatModelId),
    index('idx_threats_severity').on(t.severity),
    index('idx_threats_stride').on(t.strideCategory),
    index('idx_threats_review').on(t.reviewStatus),
  ]
)

// ─── Relations ──────────────────────────────────────────────────────────────

export const threatModelsRelations = relations(threatModels, ({ many }) => ({
  threats: many(threats),
}))

export const runArtifacts = pgTable(
  'run_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: varchar('run_id', { length: 255 })
      .notNull()
      .references(() => threatModels.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 200 }).notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_run_artifacts_run_id').on(t.runId),
    uniqueIndex('idx_run_artifacts_run_kind').on(t.runId, t.kind),
  ],
)

export const pipelineWorkers = pgTable('pipeline_workers', {
  instanceId: varchar('instance_id', { length: 128 }).primaryKey(),
  heartbeatAt: timestamp('heartbeat_at').notNull(),
  startedAt: timestamp('started_at').notNull().defaultNow(),
})

export const threatsRelations = relations(threats, ({ one }) => ({
  threatModel: one(threatModels, {
    fields: [threats.threatModelId],
    references: [threatModels.id],
  }),
}))

// ─── Select/Insert types ─────────────────────────────────────────────────────

export type ThreatModel = typeof threatModels.$inferSelect
export type NewThreatModel = typeof threatModels.$inferInsert
export type Threat = typeof threats.$inferSelect
export type NewThreat = typeof threats.$inferInsert
export type System = typeof systems.$inferSelect
export type NewSystem = typeof systems.$inferInsert

export type AuditLog = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert
