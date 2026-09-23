import postgres from 'postgres'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const sql = postgres(databaseUrl, { max: 1 })

async function main(): Promise<void> {
  const enumRows = await sql<{ type: string; value: string }[]>`
    SELECT t.typname AS type, e.enumlabel AS value
    FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname IN ('analysis_status', 'audit_event_type')
  `
  const enumValues = new Set(enumRows.map((row) => `${row.type}:${row.value}`))
  for (const expected of [
    'analysis_status:partial',
    'audit_event_type:reviewer_learning_applied',
  ]) {
    if (!enumValues.has(expected)) throw new Error(`Missing PostgreSQL enum value ${expected}`)
  }

  const uploadColumns = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'uploads'
      AND column_name IN ('sha256', 'owner_principal_id', 'owner_principal_kind')
  `
  if (uploadColumns.length !== 3) throw new Error('PostgreSQL upload ownership/hash columns are incomplete')

  const [systemFk] = await sql<{ delete_action: string }[]>`
    SELECT rc.delete_rule AS delete_action
    FROM information_schema.referential_constraints rc
    WHERE rc.constraint_schema = 'public'
      AND rc.constraint_name = 'threat_models_system_id_systems_id_fk'
  `
  if (systemFk?.delete_action !== 'SET NULL') {
    throw new Error(`threat_models.system_id delete action is ${systemFk?.delete_action ?? 'missing'}`)
  }

  console.log('PostgreSQL migration contract verified')
}

main().finally(() => sql.end())
