import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrations = join(process.cwd(), 'drizzle', 'sqlite')

function open(path: string) {
  const client = new Database(path)
  client.pragma('foreign_keys = ON')
  return { client, db: drizzle(client) }
}

describe('SQLite migration chain', () => {
  it('applies every migration to an empty database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sqlite-empty-')), 'db.sqlite')
    const { client, db } = open(path)
    migrate(db, { migrationsFolder: migrations })
    const columns = client.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string; notnull: number }>
    expect(columns.find((column) => column.name === 'run_id')?.notnull).toBe(1)
    expect(client.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_artifacts_run_kind'").get()).toBeTruthy()
    const threatModelColumns = client.prepare('PRAGMA table_info(threat_models)').all() as Array<{ name: string }>
    expect(threatModelColumns.some((column) => column.name === 'lease_expires_at')).toBe(true)
    expect(client.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tm_lease'").get()).toBeTruthy()
    client.close()
  })

  it('upgrades a pre-hardening fixture and enforces cascade plus unique kind', () => {
    const root = mkdtempSync(join(tmpdir(), 'sqlite-legacy-'))
    const oldMigrations = join(root, 'migrations')
    mkdirSync(join(oldMigrations, 'meta'), { recursive: true })
    for (const name of [
      '0000_confused_major_mapleleaf.sql',
      '0001_upload_file_artifacts.sql',
      '0002_systems.sql',
      '0003_run_lifecycle.sql',
    ]) cpSync(join(migrations, name), join(oldMigrations, name))
    const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8')) as {
      version: string
      dialect: string
      entries: unknown[]
    }
    writeFileSync(join(oldMigrations, 'meta', '_journal.json'), JSON.stringify({
      ...journal,
      entries: journal.entries.slice(0, 4),
    }))

    const path = join(root, 'fixture.sqlite')
    const legacy = open(path)
    migrate(legacy.db, { migrationsFolder: oldMigrations })
    legacy.client.prepare(`INSERT INTO threat_models (id, input, version_hash) VALUES ('run-1', 'input', 'hash')`).run()
    legacy.client.prepare(`INSERT INTO artifacts (id, run_id, kind, relative_path, mime_type, sha256, size_bytes)
      VALUES ('artifact-1', 'run-1', 'phase:test', 'test.json', 'application/json', 'hash', 1)`).run()
    legacy.client.close()

    const upgraded = open(path)
    migrate(upgraded.db, { migrationsFolder: migrations })
    expect(() => upgraded.client.prepare(`INSERT INTO artifacts (id, run_id, kind, relative_path, mime_type, sha256, size_bytes)
      VALUES ('artifact-2', 'run-1', 'phase:test', 'other.json', 'application/json', 'hash', 1)`).run()).toThrow()
    upgraded.client.prepare(`DELETE FROM threat_models WHERE id = 'run-1'`).run()
    expect(upgraded.client.prepare(`SELECT count(*) AS count FROM artifacts`).get()).toMatchObject({ count: 0 })
    upgraded.client.close()
  })
})
