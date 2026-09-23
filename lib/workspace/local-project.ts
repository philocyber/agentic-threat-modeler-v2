import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { z } from 'zod'
import { createSqliteDatabase } from '@/lib/db/sqlite'

const PROJECT_SCHEMA_VERSION = 1
const PROJECT_FILE_NAME = 'project.json'
const DATABASE_FILE_NAME = 'project.db'

const ProjectMetadataSchema = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  createdAt: z.string().datetime(),
  database: z.literal(DATABASE_FILE_NAME),
  ragMode: z.enum(['global', 'local', 'off']).default('global'),
})

const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
})

export type LocalProject = z.infer<typeof ProjectMetadataSchema> & {
  path: string
}

function workspaceRoot(): string {
  const configuredRoot = process.env.AGENTICTM_WORKSPACE_ROOT
  const defaultRoot = join(homedir(), '.agentictm', 'projects')
  // Workspace storage deliberately lives outside the application bundle.
  return resolve(/* turbopackIgnore: true */ configuredRoot ?? defaultRoot)
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'project'
}

function assertInsideRoot(root: string, candidate: string): string {
  const resolved = resolve(candidate)
  if (relative(root, resolved).startsWith('..') || relative(root, resolved) === '') {
    throw new Error('Invalid project path')
  }
  return resolved
}

function initializeDatabase(databasePath: string, project: LocalProject): void {
  const database = createSqliteDatabase(databasePath)
  try {
    migrate(database, { migrationsFolder: 'drizzle/sqlite' })
    database.$client
      .prepare(
        `CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          created_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL
        )`,
      )
      .run()
    database.$client
      .prepare(
        `INSERT INTO projects (id, name, slug, created_at, schema_version)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(project.id, project.name, project.slug, project.createdAt, project.schemaVersion)
  } finally {
    database.$client.close()
  }
}

async function writeProjectMetadata(projectPath: string, project: LocalProject): Promise<void> {
  const metadata = {
    schemaVersion: project.schemaVersion,
    id: project.id,
    name: project.name,
    slug: project.slug,
    createdAt: project.createdAt,
    database: project.database,
    ragMode: project.ragMode,
  }
  await writeFile(
    join(projectPath, PROJECT_FILE_NAME),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

async function readProject(projectPath: string): Promise<LocalProject> {
  const root = workspaceRoot()
  const safeProjectPath = assertInsideRoot(root, projectPath)
  const content = await readFile(join(safeProjectPath, PROJECT_FILE_NAME), 'utf8')
  const metadata = ProjectMetadataSchema.parse(JSON.parse(content))

  return { ...metadata, path: safeProjectPath }
}

export async function getLocalProjectById(projectId: string): Promise<LocalProject | null> {
  if (!z.string().uuid().safeParse(projectId).success) return null
  const projects = await listLocalProjects()
  return projects.find((project) => project.id === projectId) ?? null
}

export async function createLocalProject(input: unknown): Promise<LocalProject> {
  const { name } = CreateProjectSchema.parse(input)
  const root = workspaceRoot()
  const id = randomUUID()
  const projectPath = assertInsideRoot(root, join(root, `${slugify(name)}-${id.slice(0, 8)}`))
  const project: LocalProject = {
    id,
    name,
    slug: slugify(name),
    createdAt: new Date().toISOString(),
    database: DATABASE_FILE_NAME,
    ragMode: 'global',
    path: projectPath,
    schemaVersion: PROJECT_SCHEMA_VERSION,
  }

  await mkdir(root, { recursive: true, mode: 0o700 })
  await mkdir(projectPath, { recursive: false, mode: 0o700 })

  try {
    await Promise.all([
      mkdir(join(projectPath, 'inputs'), { mode: 0o700 }),
      mkdir(join(projectPath, 'prompts', 'defaults'), { recursive: true, mode: 0o700 }),
      mkdir(join(projectPath, 'prompts', 'overrides'), { recursive: true, mode: 0o700 }),
      mkdir(join(projectPath, 'runs'), { mode: 0o700 }),
      mkdir(join(projectPath, 'exports'), { mode: 0o700 }),
      mkdir(join(projectPath, 'rag'), { mode: 0o700 }),
    ])
    initializeDatabase(join(projectPath, DATABASE_FILE_NAME), project)
    await writeProjectMetadata(projectPath, project)
    return project
  } catch (error) {
    await rm(projectPath, { recursive: true, force: true })
    throw error
  }
}

export async function listLocalProjects(): Promise<LocalProject[]> {
  const root = workspaceRoot()
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readProject(join(root, basename(entry.name))).catch(() => null)),
    )
    return projects
      .filter((project): project is LocalProject => project !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
