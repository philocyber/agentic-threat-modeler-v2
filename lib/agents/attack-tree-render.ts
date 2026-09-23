import type { AttackTreeData, AttackTreeNode } from '@/lib/db/schema'

/** Deterministic ASCII rendering. Models emit nodes; they do not draw the tree. */
export function renderAttackTreeText(tree: AttackTreeData): string {
  const lines = [tree.rootGoal, renderNode(tree.tree, 0, true)]
  return lines.filter(Boolean).join('\n')
}

export function withRenderedAttackTree(tree: Omit<AttackTreeData, 'textRepresentation'> & {
  textRepresentation?: string | undefined
}): AttackTreeData {
  const data: AttackTreeData = { rootGoal: tree.rootGoal, tree: tree.tree, textRepresentation: '' }
  data.textRepresentation = renderAttackTreeText(data)
  return data
}

function renderNode(node: AttackTreeNode, depth: number, isRoot: boolean): string {
  const indent = '  '.repeat(depth)
  const label = isRoot ? `${node.goal} [ROOT]` : `${node.type}: ${node.goal}`
  const notes = node.notes ? ` — ${node.notes}` : ''
  const children = (node.children ?? []).map((child) => renderNode(child, depth + 1, false))
  return [`${indent}${label}${notes}`, ...children].join('\n')
}
