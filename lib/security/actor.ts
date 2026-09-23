import { AsyncLocalStorage } from 'node:async_hooks'

export type RequestActor = {
  id: string
  kind: 'workspace' | 'token' | 'local'
}

const actorStorage = new AsyncLocalStorage<RequestActor>()

export function runWithActor<T>(actor: RequestActor, callback: () => T): T {
  return actorStorage.run(actor, callback)
}

export function getActor(): RequestActor | undefined {
  return actorStorage.getStore()
}

export function actorRequiresOwnership(actor: RequestActor | undefined = getActor()): boolean {
  return actor?.kind === 'token'
}

export function createdByFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const value = (metadata as { createdBy?: unknown }).createdBy
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function withCreatedBy<T extends object>(
  metadata: T | null | undefined,
): T & { createdBy: string } | T {
  const actor = getActor()
  if (!actor) return (metadata ?? {}) as T
  return { ...(metadata ?? {}), createdBy: actor.id } as T & { createdBy: string }
}

export function actorCanAccess(createdBy: string | undefined): boolean {
  const actor = getActor()
  if (!actorRequiresOwnership(actor)) return true
  return createdBy === actor!.id
}
