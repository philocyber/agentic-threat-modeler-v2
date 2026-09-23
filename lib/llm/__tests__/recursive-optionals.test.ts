import { expect, it } from 'vitest'
import { z } from 'zod'
import { restoreOptionalNulls } from '../structured'

it('restores provider-introduced nulls through recursive JSON pointers', () => {
  type Node = { label: string; children?: Node[] | undefined; notes?: string | undefined; reviewed: string | null }
  const node: z.ZodType<Node> = z.object({ label: z.string(), children: z.array(z.lazy(() => node)).optional(), notes: z.string().optional(), reviewed: z.string().nullable() })
  const schema = z.object({ tree: node })
  const response = { tree: { label: 'root', notes: null, reviewed: null, children: [{ label: 'leaf', children: null, notes: null, reviewed: null }] } }
  expect(schema.safeParse(response).success).toBe(false)
  expect(node.safeParse(restoreOptionalNulls(response.tree, z.toJSONSchema(node, { io: 'input' }))).success).toBe(true)
  const restored = restoreOptionalNulls(response, z.toJSONSchema(schema, { io: 'input' }))
  expect(schema.parse(restored)).toEqual({ tree: { label: 'root', reviewed: null, children: [{ label: 'leaf', reviewed: null }] } })
  expect(schema.safeParse(restoreOptionalNulls({ tree: { label: null, reviewed: null } }, z.toJSONSchema(schema, { io: 'input' }))).success).toBe(false)
})
