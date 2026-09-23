import { hostname } from 'node:os'
import { tagWorkerInstanceId } from '@/lib/pipeline/worker-version'

export function createWorkerInstanceId(): string {
  const configured = process.env.INSTANCE_ID?.trim()
  const raw = configured || `${hostname()}:${process.pid}:${crypto.randomUUID()}`
  return tagWorkerInstanceId(raw)
}
