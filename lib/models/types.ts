import type { ArchitectureData, UnifiedThreat, AnalysisConfig, AnalysisMetadata, AttackTreeData } from '@/lib/db/schema'
import type { RagHealth } from '@/lib/health/rag-status'

export type {
  ArchitectureData,
  UnifiedThreat,
  AnalysisConfig,
} from '@/lib/db/schema'

type ThreatTraceability = {
  trustBoundaries?: string[] | undefined
  components?: string[] | undefined
  endpoints?: string[] | undefined
  environmentVars?: string[] | undefined
  securityConfigs?: string[] | undefined
}

export type RawThreat = {
  disposition?: UnifiedThreat['disposition']
  preconditions?: string[] | undefined
  candidateId?: string | undefined
  component: string
  strideCategory?: string | undefined
  methodology: 'STRIDE' | 'PASTA' | 'ATTACK_TREE'
  methodologies?: Array<'STRIDE' | 'PASTA' | 'ATTACK_TREE'> | undefined
  description: string
  impact: string
  mitigation: string
  controlReference?: string | null | undefined
  confidenceScore: number
  evidenceSources: Array<{
    sourceType: 'rag' | 'architecture'
    sourceName: string
    excerpt: string
  }>
  reasoning?: string | null | undefined
  attackerProfile?: string | undefined
  attackVector?: string | undefined
  attackTree?: AttackTreeData | undefined
  traceability?: ThreatTraceability | undefined
}

export type DebateRound = {
  round: number
  /** False while configured dialogue rounds remain. Absent on legacy reports. */
  isFinalRound?: boolean | undefined
  redTeamArguments: string
  blueTeamArguments: string
  convergenceSignal: boolean
  judgeSummary?: string | undefined
  judgeConverged?: boolean | undefined
  threatAssessments: Array<{
    /** Stable candidate identifier (`DRAFT-n`) supplied to every debate actor. */
    draftId: string
    threatDescription: string
    redVerdict: 'critical' | 'high' | 'medium' | 'low' | 'invalid' | 'unavailable' | 'unresolved'
    blueVerdict: 'critical' | 'high' | 'medium' | 'low' | 'invalid' | 'unavailable' | 'unresolved'
    finalVerdict: 'critical' | 'high' | 'medium' | 'low' | 'invalid' | 'unresolved'
    redDisposition?: string | undefined
    blueDisposition?: string | undefined
    /** Team agreement is independent of an adjudicator's decision. */
    consensus?: 'agreed' | 'disagreed' | 'unverified' | undefined
    /** Legacy three-turn format only. New rounds contain one Red and one Blue turn. */
    redReplyVerdict?: 'critical' | 'high' | 'medium' | 'low' | 'invalid' | 'unresolved' | undefined
    redReplyDisposition?: string | undefined
    redReplyNotes?: string | undefined
    qualityIssues?: string[] | undefined
    disposition?: 'applicable' | 'conditional' | 'control_verification_needed' | 'mitigated' | 'invalid' | undefined
    notes: string
    component?: string | undefined
    methodology?: RawThreat['methodology'] | undefined
    redNotes?: string | undefined
    blueNotes?: string | undefined
    /** Narrative checkpoint from a provisional round; it is not a judge ruling. */
    interimSummary?: string | undefined
    /** Historical field for the final written close, either a ruling or agreed team conclusion. */
    judgeNotes?: string | undefined
  }>
}

/** A pre-synthesis candidate. Raw threats intentionally have no invented DREAD score. */
export type DebateCandidate = RawThreat & {
  draftId: string
}

export type ProgressEvent = {
  phase: string
  status: 'start' | 'done' | 'error'
  count?: number | undefined
  message?: string | undefined
  timestamp: number
}

/**
 * Marks a pipeline stage that exhausted its retries and continued degraded
 * (e.g. an analyst that returned zero threats). Surfaced in the graph state so
 * the UI can render a prominent degradation banner — never degrade silently.
 */
export type DegradedAgentInfo = {
  agent: string
  error: string
  at: number
}

// ─── LangGraph State ─────────────────────────────────────────────────────────

export type ThreatModelState = {
  // Inputs
  systemName: string
  rawInput: string
  config: AnalysisConfig

  // Phase I
  architectureData: ArchitectureData | null

  // Phase II — raw threats from each analyst
  strideThreats: RawThreat[]
  pastaThreats: RawThreat[]
  attackTreeThreats: RawThreat[]

  // Confidence-filtered threats (post pre_dedup)
  threatsKept: RawThreat[]

  // Phase III — debate
  debateRounds: DebateRound[]

  // Phase IV — synthesis
  threatsPreDedup: UnifiedThreat[]
  threatsFinal: UnifiedThreat[]
  filteredCount: number

  // Control
  errors: string[]
  degradedAgents: DegradedAgentInfo[]
  progressEvents: ProgressEvent[]
}

// ─── API types ───────────────────────────────────────────────────────────────

export type AnalyzeRequest = {
  input: string
  systemName: string
  systemId?: string | undefined
  inputType?: 'text' | 'file'
  config?: Partial<AnalysisConfig>
  // RFC integration
  metadata?: Partial<AnalysisMetadata>
  upload_ids?: string[]
  /**
   * Id of a previous run whose completed phases seed this one. The reused phases
   * are not sent to the model again, so a run that died late is cheap to retry.
   */
  resumeFrom?: string
  // External integrator fields
  externalId?: string
  webhookUrl?: string
  webhookSecret?: string   // sent as Authorization: Bearer <secret> in the callback request
}

export type AnalyzeResponse = {
  analysisId: string
  status: 'pending'
  metadata: AnalysisMetadata
  status_url: string
  created_at: string
}

export type AnalysisStatusResponse = {
  analysis_id: string
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed'
  progress: {
    current_phase?: string | undefined
    events?: ProgressEvent[]
    phases_completed: string[]
    phases_failed?: string[] | undefined
    phases_remaining: string[]
    percentage: number
  }
  started_at: string
  completed_at?: string | undefined
  metadata?: AnalysisMetadata | null | undefined
  error_message?: string | null | undefined
  stop_reason?: 'user_cancelled' | undefined
}

// ─── Threat editing types ────────────────────────────────────────────────────

export type ThreatUpdateRequest = {
  description?: string
  stride_category?: string
  dread_damage?: number
  dread_reproducibility?: number
  dread_exploitability?: number
  dread_affected_users?: number
  dread_discoverability?: number
  review_status?: 'pending' | 'confirmed' | 'rejected'
  review_notes?: string
  // reviewedAt is maintained locally when review fields change.
}

export type ThreatCommentRequest = {
  user_comments: string
}

export type HealthStatus = {
  status: 'ok' | 'degraded' | 'error'
  services: {
    database: 'up' | 'down' | 'not_configured'
    ollama: 'up' | 'down' | 'not_configured'
    chromadb: 'up' | 'down' | 'not_configured'
    gemini: 'up' | 'down' | 'not_configured'
    kimi: 'up' | 'down' | 'not_configured'
    bedrock: 'up' | 'down' | 'not_configured'
    cursor: 'up' | 'down' | 'not_configured'
    worker: 'up' | 'down' | 'not_configured'
  }
  worker?: {
    status: 'up' | 'down'
    lastSeenAt: string | null
    compatible?: boolean
    codeVersion?: string | null
    requiredVersion?: string
    recovery?: string[]
  }
  ollamaModels?: (import('@/lib/health/ollama-models').OllamaModelReadiness & { quickModel?: string; deepModel?: string }) | undefined
  rag?: RagHealth
  ragDefaultEnabled?: boolean
  llmProvider?: string
  mode?: string
  timestamp: string
}

// ─── SSE Event types ─────────────────────────────────────────────────────────

/**
 * What /api/v1/analysis/[id]/stream actually emits. `complete` and `error` have
 * two shapes each: one raised from a progress event, one from the poll snapshot.
 */
export type SSEEvent =
  | { event: 'started'; data: { analysisId: string; status: string } }
  | {
      event: 'progress'
      data: { phase: string; status: ProgressEvent['status']; count?: number | undefined; timestamp: number }
    }
  | {
      event: 'complete'
      data:
        | { analysisId: string; phase: string; timestamp: number }
        | {
            analysisId: string
            /** `completed` or `partial`: both delivered threats. */
            status?: string
            totalThreats: number | null
            durationMs: number | null
          }
    }
  | {
      event: 'error'
      data:
        | { analysisId: string; phase: string; timestamp: number }
        | { analysisId: string; message: string | null; stop_reason?: 'user_cancelled' | undefined }
    }
  | { event: 'timeout'; data: { message: string } }
  | { event: 'log'; data: { message: string; at: number; kind?: string } }
