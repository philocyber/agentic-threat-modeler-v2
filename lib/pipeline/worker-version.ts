import { PIPELINE_WORKER_CODE_VERSION, WORKER_RECOVERY_ACTION } from '@/lib/contracts/versions'

const VERSION_SEPARATOR = '::'

export function tagWorkerInstanceId(raw: string): string {
  if (raw.includes(VERSION_SEPARATOR)) return raw
  const tagged = `${PIPELINE_WORKER_CODE_VERSION}${VERSION_SEPARATOR}${raw}`
  return tagged.length <= 128 ? tagged : raw
}

export function workerCodeVersionOf(instanceId: string | null | undefined): string | null {
  if (!instanceId) return null
  const index = instanceId.indexOf(VERSION_SEPARATOR)
  if (index <= 0) return null
  const version = instanceId.slice(0, index)
  return /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(version) ? version : null
}

export function workerCompatibility(params: {
  status: 'up' | 'down'
  instanceId?: string | null
  codeVersion?: string | null
}): {
  compatible: boolean
  codeVersion: string | null
  requiredVersion: string
  recovery: string[]
} {
  const codeVersion = params.codeVersion ?? workerCodeVersionOf(params.instanceId)
  if (params.status !== 'up') {
    return {
      compatible: true,
      codeVersion,
      requiredVersion: PIPELINE_WORKER_CODE_VERSION,
      recovery: [],
    }
  }
  const compatible = codeVersion === PIPELINE_WORKER_CODE_VERSION
  return {
    compatible,
    codeVersion,
    requiredVersion: PIPELINE_WORKER_CODE_VERSION,
    recovery: compatible ? [] : [WORKER_RECOVERY_ACTION],
  }
}
