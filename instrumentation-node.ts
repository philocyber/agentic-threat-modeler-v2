import { validateConfig } from '@/lib/config'

export async function registerNodeRuntime(): Promise<void> {
  validateConfig()
}
