import { afterEach, expect, it, vi } from 'vitest'
import { writeFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { saveProviderCredentials } from '@/lib/llm/provider-credentials'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(''), writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined), unlink: vi.fn().mockResolvedValue(undefined),
}))
afterEach(() => vi.unstubAllEnvs())

it('recovers the serialized write queue after a failed write without hiding that failure', async () => {
  vi.stubEnv('GOOGLE_API_KEY', '')
  vi.mocked(writeFile).mockRejectedValueOnce(new Error('Disk unavailable'))
  await expect(saveProviderCredentials({ provider: 'google', apiKey: 'synthetic-first-value' })).rejects.toThrow('Disk unavailable')
  expect(process.env.GOOGLE_API_KEY).toBe('')
  await expect(saveProviderCredentials({ provider: 'google', apiKey: 'synthetic-recovered-value' })).resolves.toBeUndefined()
  expect(writeFile).toHaveBeenCalledTimes(2)
  expect(rename).toHaveBeenCalledTimes(1)
  expect(process.env.GOOGLE_API_KEY).toBe('synthetic-recovered-value')
})

it('persists credentials outside the generated standalone directory when configured', async () => {
  vi.stubEnv('AGENTICTM_ENV_FILE', '/tmp/agentictm-synthetic-root/.env.local')
  vi.resetModules()
  const { saveProviderCredentials: save } = await import('@/lib/llm/provider-credentials')
  await save({ provider: 'google', apiKey: 'synthetic-external-value' })
  const target = resolve('/tmp/agentictm-synthetic-root/.env.local')
  const [tempPath, destination] = vi.mocked(rename).mock.lastCall!
  expect(destination).toBe(target)
  expect(typeof tempPath).toBe('string')
  expect(String(tempPath).startsWith(`${target}.`)).toBe(true)
  expect(String(tempPath).endsWith('.tmp')).toBe(true)
})
