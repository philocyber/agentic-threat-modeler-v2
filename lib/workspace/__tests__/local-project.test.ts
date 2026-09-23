import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalProject, listLocalProjects } from '../local-project'

const originalRoot = process.env.AGENTICTM_WORKSPACE_ROOT
let testRoot: string | undefined

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
  if (originalRoot === undefined) delete process.env.AGENTICTM_WORKSPACE_ROOT
  else process.env.AGENTICTM_WORKSPACE_ROOT = originalRoot
})

describe('local project workspaces', () => {
  it('creates an isolated workspace with a private SQLite database', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-workspaces-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot

    const project = await createLocalProject({ name: 'Payments / API' })

    expect(project.slug).toBe('payments-api')
    expect(project.path).toMatch(/payments-api-[a-f0-9]{8}$/)

    const metadata = JSON.parse(await readFile(join(project.path, 'project.json'), 'utf8'))
    expect(metadata).toMatchObject({
      id: project.id,
      name: 'Payments / API',
      database: 'project.db',
      schemaVersion: 1,
    })

    const database = new Database(join(project.path, 'project.db'), { readonly: true })
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    database.close()
    expect(tables.map((table) => table.name)).toEqual([
      '__drizzle_migrations',
      'artifacts',
      'audit_logs',
      'projects',
      'systems',
      'threat_models',
      'threats',
      'uploads',
    ])
  })

  it('lists only valid project manifests from the configured root', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-workspaces-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const created = await createLocalProject({ name: 'Inventory' })

    const projects = await listLocalProjects()

    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ id: created.id, name: 'Inventory' })
  })
})
