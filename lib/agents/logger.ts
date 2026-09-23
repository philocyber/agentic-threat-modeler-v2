import { AsyncLocalStorage } from 'node:async_hooks'

const _store = new AsyncLocalStorage<(msg: string) => void>()

export function runWithAgentLogger<T>(onLog: (msg: string) => void, fn: () => T): T {
  return _store.run(onLog, fn)
}

export function agentLog(msg: string): void {
  console.log(msg)
  _store.getStore()?.(msg)
}

export function agentWarn(msg: string): void {
  console.warn(msg)
  _store.getStore()?.(msg)
}
