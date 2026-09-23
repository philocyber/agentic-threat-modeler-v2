import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.sqlite'

export function createSqliteDatabase(databasePath: string) {
  const client = new Database(databasePath)
  client.pragma('journal_mode = WAL')
  client.pragma('foreign_keys = ON')
  client.pragma('busy_timeout = 30000')
  return drizzle(client, { schema })
}

export type SqliteDatabase = ReturnType<typeof createSqliteDatabase>
