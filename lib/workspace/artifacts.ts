import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { getActiveWorkspace } from './context'
import type { LocalProject } from './local-project'

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Resolve a path strictly inside the workspace. Throws on any traversal attempt.
 */
export function resolveWorkspacePath(workspace: LocalProject, ...segments: string[]): string {
  const candidate = resolve(workspace.path, ...segments)
  const rel = relative(workspace.path, candidate)
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error('Invalid workspace path')
  }
  return candidate
}

/** Atomic write: temp file + rename, so readers never see partial content. */
export async function writeArtifactAtomic(
  workspace: LocalProject,
  relativePath: string,
  content: string | Buffer,
): Promise<{ sha256: string; sizeBytes: number }> {
  const target = resolveWorkspacePath(workspace, relativePath)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.${randomUUID()}.tmp`
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, target)
  return { sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content) }
}

async function appendJsonl(
  workspace: LocalProject,
  relativeSegments: string[],
  event: Record<string, unknown>,
): Promise<void> {
  const target = resolveWorkspacePath(workspace, ...relativeSegments)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await appendFile(target, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export async function appendProgressEvent(
  workspace: LocalProject,
  runId: string,
  event: Record<string, unknown>,
): Promise<void> {
  await appendJsonl(workspace, ['runs', runId, 'progress.jsonl'], event)
}

export async function appendTelemetryEvent(
  workspace: LocalProject,
  runId: string,
  event: Record<string, unknown>,
): Promise<void> {
  await appendJsonl(workspace, ['runs', runId, 'telemetry.jsonl'], event)
}

export async function readWorkspaceText(
  workspace: LocalProject,
  relativePath: string,
): Promise<string> {
  return readFile(resolveWorkspacePath(workspace, relativePath), 'utf8')
}

/** Remove only the artifact folder owned by a completed or failed run. */
export async function removeWorkspaceRunArtifacts(workspace: LocalProject, runId: string): Promise<void> {
  const target = resolveWorkspacePath(workspace, 'runs', runId)
  await rm(target, { recursive: true, force: true })
}

/** Remove only one upload folder selected from a database row. */
export async function removeWorkspaceUploadArtifacts(
  workspace: LocalProject,
  relativePath: string,
): Promise<void> {
  const target = resolveWorkspacePath(workspace, relativePath)
  await rm(target, { recursive: true, force: true })
}

/** Active workspace or null — artifact writes are no-ops in Postgres mode. */
export function activeWorkspaceOrNull(): LocalProject | null {
  return getActiveWorkspace()
}
