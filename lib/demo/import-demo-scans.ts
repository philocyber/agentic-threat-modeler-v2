import ollama from '@/demo-scans/ollama.json'
import cursor from '@/demo-scans/cursor.json'
import kimi from '@/demo-scans/kimi.json'
import { getStorage } from '@/lib/storage/context'
import { getRunArtifact, putRunArtifactContent } from '@/lib/storage/artifacts'
import { calculateVersionHash } from '@/lib/utils/version-hash'

type DemoScan = {
  schemaVersion: number
  model: Record<string, unknown> & { id: string; title: string; input: string; total_threats: number; metadata: Record<string, unknown> }
  threats: Array<Record<string, unknown> & { id: string; threat_model_id: string }>
  report: string
}

const scans: DemoScan[] = [ollama, cursor, kimi] as DemoScan[]
const MODEL_COLUMNS = [
  'id', 'system_id', 'title', 'input', 'metadata', 'version_hash', 'status', 'current_phase',
  'system_description', 'debate_summary', 'methodologies_used', 'architecture_json',
  'llm_tokens_used', 'execution_time_seconds', 'total_threats', 'filtered_threats',
  'pipeline_errors', 'queued_at', 'started_at', 'completed_at', 'created_at', 'updated_at',
] as const
const THREAT_COLUMNS = [
  'id', 'threat_model_id', 'title', 'description', 'component', 'stride_category', 'pasta_phase',
  'methodology', 'dread_damage', 'dread_reproducibility', 'dread_exploitability',
  'dread_affected_users', 'dread_discoverability', 'severity', 'impact', 'mitigation',
  'control_reference', 'attack_scenarios', 'recommended_controls', 'owasp_categories',
  'confidence_score', 'evidence_sources', 'reasoning', 'methodology_data', 'review_status',
  'traceability', 'created_at',
] as const
const JSON_COLUMNS = new Set([
  'metadata', 'methodologies_used', 'architecture_json', 'pipeline_errors', 'attack_scenarios',
  'recommended_controls', 'owasp_categories', 'evidence_sources', 'methodology_data', 'traceability',
])
const ORIGINAL_CLASSIFICATION = 'Classification: Internal — Confidential'
const DEMO_CLASSIFICATION = 'Classification: Synthetic — Public Demo'

function insertRow(
  db: ReturnType<typeof getStorage> & { kind: 'sqlite' },
  table: 'threat_models' | 'threats',
  columns: readonly string[],
  row: Record<string, unknown>,
): void {
  const values = columns.map((column) => {
    const value = row[column] ?? null
    return value !== null && JSON_COLUMNS.has(column) ? JSON.stringify(value) : value
  })
  db.db.$client.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values)
}

export async function importDemoScans(): Promise<{ imported: number; existing: number }> {
  const storage = getStorage()
  if (storage.kind !== 'sqlite') throw new Error('Demo scans require a local project')

  const imported: DemoScan[] = []
  let existing = 0
  storage.db.$client.transaction(() => {
    storage.db.$client.prepare(`INSERT INTO systems (id, name, description, metadata)
      VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
      'sys_demo_financebot', 'FinanceBot', 'Fictional banking assistant used in the public demo scans.',
      JSON.stringify({ demo: true }),
    )
    for (const scan of scans) {
      const { model, threats } = scan
      if (scan.schemaVersion !== 1 || model.status !== 'completed' ||
          threats.length !== model.total_threats ||
          threats.some((threat) => threat.threat_model_id !== model.id)) {
        throw new Error(`Invalid bundled demo scan: ${model.id}`)
      }
      const row = storage.db.$client.prepare('SELECT title, input, total_threats, metadata FROM threat_models WHERE id = ?')
        .get(model.id) as { title: string; input: string; total_threats: number; metadata: string | null } | undefined
      if (row) {
        // An older copy of these exact local runs may still carry the original
        // classification. Mark only a matching run; never overwrite user data.
        if (row.title !== model.title || row.total_threats !== model.total_threats ||
            row.input.replaceAll(ORIGINAL_CLASSIFICATION, DEMO_CLASSIFICATION) !== model.input) {
          throw new Error(`Run ID already belongs to a different analysis: ${model.id}`)
        }
        const metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>
        if (metadata.demo !== true) {
          storage.db.$client.prepare('UPDATE threat_models SET metadata = ? WHERE id = ?')
            .run(JSON.stringify({ ...metadata, demo: true }), model.id)
        }
        existing++
        continue
      }
      const versionHash = calculateVersionHash({ systemName: model.title, input: model.input })
      insertRow(storage, 'threat_models', MODEL_COLUMNS, {
        ...model,
        version_hash: versionHash,
        metadata: { ...model.metadata, demo: true, version_hash: versionHash },
      })
      for (const threat of threats) insertRow(storage, 'threats', THREAT_COLUMNS, threat)
      imported.push(scan)
    }
  })()

  for (const scan of imported) {
    if (!(await getRunArtifact(scan.model.id, 'report'))) {
      await putRunArtifactContent({
        runId: scan.model.id,
        kind: 'report',
        content: scan.report,
        mimeType: 'text/markdown',
        relativePath: `runs/${scan.model.id}/report.md`,
      })
    }
  }
  return { imported: imported.length, existing }
}
