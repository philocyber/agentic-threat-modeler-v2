import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve } from 'node:path'
import { db as postgresDb } from '@/lib/db'
import { createSqliteDatabase, type SqliteDatabase } from '@/lib/db/sqlite'
import { getActiveWorkspace } from '@/lib/workspace/context'

const sqliteConnections = new Map<string, SqliteDatabase>()

function getWorkspaceDb(databasePath: string): SqliteDatabase {
  const existing = sqliteConnections.get(databasePath)
  if (existing) return existing
  const created = createSqliteDatabase(databasePath)
  // Idempotent: drizzle tracks applied migrations, so existing project
  // databases pick up new migrations on first access after an upgrade.
  migrate(created, { migrationsFolder: 'drizzle/sqlite' })
  sqliteConnections.set(databasePath, created)
  return created
}

export function getStorage() {
  const workspace = getActiveWorkspace()
  if (!workspace) {
    // Without DATABASE_URL there is no Postgres to fall back to: the caller
    // reached storage before a local project was selected.
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'No active local project. Select one under "Manage local projects", or set DATABASE_URL to use Postgres.',
      )
    }
    return { kind: 'postgres' as const, db: postgresDb }
  }
  return { kind: 'sqlite' as const, db: getWorkspaceDb(resolve(workspace.path, workspace.database)) }
}

export function closeWorkspaceStorage(databasePath: string): void {
  const normalizedPath = resolve(databasePath)
  const connection = sqliteConnections.get(normalizedPath)
  if (!connection) return
  connection.$client.close()
  sqliteConnections.delete(normalizedPath)
}

export function closeAllWorkspaceStorage(): void {
  for (const connection of sqliteConnections.values()) connection.$client.close()
  sqliteConnections.clear()
}
