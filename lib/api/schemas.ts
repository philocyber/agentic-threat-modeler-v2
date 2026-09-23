import { z } from 'zod'
import { LLM_PROVIDERS } from '@/lib/llm/providers'

const analyst = z.enum(['stride', 'pasta', 'attack_tree'])

export const AnalyzeRequestSchema = z.object({
  input: z.string().max(500_000).default(''),
  systemName: z.string().trim().min(1).max(255),
  systemId: z.string().max(255).optional(),
  inputType: z.enum(['text', 'file']).optional(),
  upload_ids: z.array(z.string().uuid()).max(20).optional(),
  resumeFrom: z.string().max(255).optional(),
  externalId: z.string().max(255).optional(),
  webhookUrl: z.string().url().max(2_048).optional(),
  webhookSecret: z.string().max(4_096).optional(),
  metadata: z.object({
    source: z.string().max(100).optional(),
    rfc_id: z.string().max(255).optional(),
    rfc_document_id: z.string().max(255).optional(),
    rfc_version: z.number().int().nonnegative().optional(),
    project_id: z.string().max(255).optional(),
    workflow_execution_id: z.string().max(255).optional(),
  }).strict().optional(),
  config: z.object({
    provider: z.enum(LLM_PROVIDERS).optional(),
    allowedProviders: z.array(z.enum(LLM_PROVIDERS)).max(5).optional(),
    executionProfile: z.enum(['local_efficient', 'provider_optimized', 'provider_full_power', 'adaptive_value']).optional(),
    allowedProfiles: z.array(z.enum(['local_efficient', 'provider_optimized', 'provider_full_power', 'adaptive_value'])).max(4).optional(),
    quickModel: z.string().max(120).optional(),
    deepModel: z.string().max(120).optional(),
    enabledAnalysts: z.array(analyst).min(1).max(3).optional(),
    executionMode: z.enum(['hybrid', 'parallel', 'cascade']).optional(),
    maxDebateRounds: z.number().int().min(1).max(5).optional(),
    targetThreats: z.number().int().min(1).max(50).optional(),
    requireEvidenceForHighPriority: z.boolean().optional(),
    useRag: z.boolean().optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (!value.input.trim() && !value.upload_ids?.length) {
    context.addIssue({ code: 'custom', path: ['input'], message: 'input or at least one upload_id is required' })
  }
})

const dreadScore = z.number().int().min(1).max(10)
export const ThreatUpdateRequestSchema = z.object({
  description: z.string().max(5_000).optional(),
  stride_category: z.enum([
    'S', 'T', 'R', 'I', 'D', 'E', 'Spoofing', 'Tampering', 'Repudiation',
    'Information Disclosure', 'Denial of Service', 'Elevation of Privilege',
  ]).optional(),
  dread_damage: dreadScore.optional(),
  dread_reproducibility: dreadScore.optional(),
  dread_exploitability: dreadScore.optional(),
  dread_affected_users: dreadScore.optional(),
  dread_discoverability: dreadScore.optional(),
  review_status: z.enum(['pending', 'confirmed', 'rejected']).optional(),
  review_notes: z.string().max(4_000).optional(),
}).strict()

export const ThreatCommentRequestSchema = z.object({
  user_comments: z.string().max(10_000),
}).strict()

export const LifecycleActionRequestSchema = z.object({
  action: z.enum(['archive', 'restore']),
}).strict()

export const RenameAnalysisRequestSchema = z.object({
  systemName: z.string().trim().min(1).max(255),
}).strict()
