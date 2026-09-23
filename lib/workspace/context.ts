import { AsyncLocalStorage } from 'node:async_hooks'
import type { LocalProject } from './local-project'

type WorkspaceContext = {
  project: LocalProject
}

const workspaceStorage = new AsyncLocalStorage<WorkspaceContext>()

export function runWithWorkspace<T>(project: LocalProject, callback: () => T): T {
  return workspaceStorage.run({ project }, callback)
}

export function getActiveWorkspace(): LocalProject | null {
  return workspaceStorage.getStore()?.project ?? null
}
