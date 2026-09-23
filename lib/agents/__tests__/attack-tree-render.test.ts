import { describe, expect, it } from 'vitest'
import { withRenderedAttackTree } from '../attack-tree-render'
import { AttackTreeSchema } from '@/lib/models/schemas'

describe('attack tree rendering', () => {
  it('builds ASCII from structured nodes instead of asking the model to draw', () => {
    const rendered = withRenderedAttackTree({
      rootGoal: 'Exfiltrate PII',
      tree: {
        goal: 'Exfiltrate PII',
        type: 'OR',
        children: [
          { goal: 'Compromise API', type: 'OR', children: [{ goal: 'Auth bypass', type: 'LEAF' }] },
          { goal: 'Reach datastore', type: 'AND', children: [{ goal: 'Network access', type: 'LEAF' }] },
        ],
      },
    })
    expect(rendered.textRepresentation).toContain('Exfiltrate PII [ROOT]')
    expect(rendered.textRepresentation).toContain('OR: Compromise API')
    expect(rendered.textRepresentation).toContain('LEAF: Auth bypass')
    expect(rendered.textRepresentation).toContain('AND: Reach datastore')
  })

  it('bounds generated trees to three paths with three atomic leaves each', () => {
    const valid = {
      rootGoal: 'Exfiltrate PII',
      tree: {
        goal: 'Exfiltrate PII', type: 'OR' as const,
        children: [{ goal: 'Compromise API', type: 'AND' as const, children: [
          { goal: 'Obtain credentials', type: 'LEAF' as const },
          { goal: 'Call export endpoint', type: 'LEAF' as const },
        ] }],
      },
    }
    expect(AttackTreeSchema.safeParse(valid).success).toBe(true)
    expect(AttackTreeSchema.safeParse({ ...valid, tree: {
      ...valid.tree,
      children: Array.from({ length: 4 }, (_, index) => ({ goal: `Path ${index}`, type: 'AND', children: [{ goal: 'Step', type: 'LEAF' }] })),
    } }).success).toBe(false)
    expect(AttackTreeSchema.safeParse({ ...valid, tree: {
      ...valid.tree,
      children: [{ goal: 'Recursive path', type: 'AND', children: [{ goal: 'Non-atomic leaf', type: 'LEAF', children: [{ goal: 'Forbidden depth', type: 'LEAF' }] }] }],
    } }).success).toBe(false)
  })
})
