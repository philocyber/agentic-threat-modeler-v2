// ─── Shared Zod schemas for pipeline agents ──────────────────────────────────
//
// Single source of truth for schemas previously copy-pasted across
// stride-analyst, pasta-analyst, attack-tree-analyst and threat-synthesizer.

import { z } from 'zod'
import type { AttackTreeData, AttackTreeNode } from '@/lib/db/schema'

export const TraceabilitySchema = z.object({
  trustBoundaries: z.array(z.string()).optional(),
  components: z.array(z.string()).optional(),
  endpoints: z.array(z.string()).optional(),
  environmentVars: z.array(z.string()).optional(),
  securityConfigs: z.array(z.string()).optional(),
})

const AttackLeafSchema: z.ZodType<AttackTreeNode> = z.strictObject({
  goal: z.string().min(1).max(180),
  type: z.literal('LEAF'),
  notes: z.string().max(240).optional(),
})

const AttackPathSchema: z.ZodType<AttackTreeNode> = z.strictObject({
  goal: z.string().min(1).max(180),
  type: z.enum(['OR', 'AND']),
  children: z.array(AttackLeafSchema).min(1).max(3),
  notes: z.string().max(240).optional(),
})

// A finite schema prevents local constrained decoders from recursively
// expanding an optional node forever. One root with three paths of three
// atomic steps still represents a complete 13-node attack tree.
const AttackRootSchema: z.ZodType<AttackTreeNode> = z.strictObject({
  goal: z.string().min(1).max(180),
  type: z.enum(['OR', 'AND']),
  children: z.array(AttackPathSchema).min(1).max(3),
  notes: z.string().max(240).optional(),
})

export const AttackTreeSchema: z.ZodType<AttackTreeData> = z.object({
  rootGoal: z.string().min(1).max(180),
  tree: AttackRootSchema,
  textRepresentation: z.literal('').optional().default(''),
})
