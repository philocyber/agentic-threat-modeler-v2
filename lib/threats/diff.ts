import type { UnifiedThreat } from '@/lib/models/types'

type ThreatDiffEntry = {
  key: string
  title: string
  component: string
  priority: string
  description: string
}

type ThreatDiffChange = ThreatDiffEntry & {
  before: ThreatDiffEntry
  after: ThreatDiffEntry
  changedFields: string[]
}

export type ThreatDiffResult = {
  baseRunId: string
  compareRunId: string
  added: ThreatDiffEntry[]
  removed: ThreatDiffEntry[]
  changed: ThreatDiffChange[]
  unchangedCount: number
}

function threatKey(t: UnifiedThreat): string {
  const title = (t.title ?? t.description).toLowerCase().replace(/\s+/g, ' ').trim()
  return `${t.component.toLowerCase()}::${title.slice(0, 120)}`
}

function toEntry(t: UnifiedThreat): ThreatDiffEntry {
  return {
    key: threatKey(t),
    title: t.title ?? t.description.slice(0, 80),
    component: t.component,
    priority: t.priority,
    description: t.description,
  }
}

function diffFields(before: UnifiedThreat, after: UnifiedThreat): string[] {
  const fields: string[] = []
  if (before.priority !== after.priority) fields.push('priority')
  if (before.description !== after.description) fields.push('description')
  if (before.dread.total !== after.dread.total) fields.push('dread')
  if ((before.title ?? '') !== (after.title ?? '')) fields.push('title')
  return fields
}

export function diffThreatRuns(
  baseRunId: string,
  compareRunId: string,
  baseThreats: UnifiedThreat[],
  compareThreats: UnifiedThreat[],
): ThreatDiffResult {
  const baseMap = new Map(baseThreats.map((t) => [threatKey(t), t]))
  const compareMap = new Map(compareThreats.map((t) => [threatKey(t), t]))

  const added: ThreatDiffEntry[] = []
  const removed: ThreatDiffEntry[] = []
  const changed: ThreatDiffChange[] = []
  let unchangedCount = 0

  for (const [key, threat] of compareMap) {
    const prior = baseMap.get(key)
    if (!prior) {
      added.push(toEntry(threat))
      continue
    }
    const changedFields = diffFields(prior, threat)
    if (changedFields.length > 0) {
      changed.push({
        ...toEntry(threat),
        before: toEntry(prior),
        after: toEntry(threat),
        changedFields,
      })
    } else {
      unchangedCount++
    }
  }

  for (const [key, threat] of baseMap) {
    if (!compareMap.has(key)) removed.push(toEntry(threat))
  }

  return { baseRunId, compareRunId, added, removed, changed, unchangedCount }
}
