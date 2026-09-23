import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { clearConfigCache, type AppConfig } from '@/lib/config'
import type { LLMProvider } from '@/lib/llm/providers'

export type ProviderCredentials =
  | { provider: 'google'; apiKey: string }
  | {
      provider: 'kimi'
      apiKey: string
      baseUrl: 'https://api.moonshot.ai/v1' | 'https://api.moonshot.cn/v1'
    }
  | {
      provider: 'bedrock'
      region: string
      accessKeyId: string
      secretAccessKey: string
      sessionToken?: string
    }
  | { provider: 'cursor'; apiKey: string }

type CredentialStatus = { configured: boolean; managedLocally: boolean }

const ENV_FILE = resolve(process.env.AGENTICTM_ENV_FILE || '.env.local')
const PROVIDER_ENV_NAMES: Record<Exclude<LLMProvider, 'ollama'>, string[]> = {
  google: ['GOOGLE_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY', 'KIMI_BASE_URL', 'MOONSHOT_BASE_URL'],
  bedrock: [
    'BEDROCK_AWS_REGION',
    'BEDROCK_AWS_ACCESS_KEY_ID',
    'BEDROCK_AWS_SECRET_ACCESS_KEY',
    'BEDROCK_AWS_SESSION_TOKEN',
  ],
  cursor: ['CURSOR_API_KEY'],
}

let credentialWriteQueue: Promise<void> = Promise.resolve()

function serializeEnvValue(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`
}

async function readEnvFile(): Promise<string> {
  try {
    return await readFile(ENV_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function envNamesInFile(content: string): Set<string> {
  const names = new Set<string>()
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)
    if (match?.[1]) names.add(match[1])
  }
  return names
}

function replaceEnvValues(
  content: string,
  names: readonly string[],
  values: Record<string, string | undefined>,
): string {
  const targetNames = new Set(names)
  const retained = content
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)
      return !match?.[1] || !targetNames.has(match[1])
    })

  while (retained.length > 0 && retained.at(-1)?.trim() === '') retained.pop()

  const additions = Object.entries(values)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, value]) => `${name}=${serializeEnvValue(value)}`)

  if (additions.length > 0) {
    retained.push('', '# Provider credentials managed by the Argus local UI', ...additions)
  }

  return `${retained.join('\n')}\n`
}

async function writeEnvFile(content: string): Promise<void> {
  const temporaryPath = `${ENV_FILE}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporaryPath, ENV_FILE)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

function valuesFor(credentials: ProviderCredentials): Record<string, string | undefined> {
  switch (credentials.provider) {
    case 'google':
      return { GOOGLE_API_KEY: credentials.apiKey }
    case 'kimi':
      return {
        MOONSHOT_API_KEY: credentials.apiKey,
        KIMI_BASE_URL: credentials.baseUrl,
      }
    case 'bedrock':
      return {
        BEDROCK_AWS_REGION: credentials.region,
        BEDROCK_AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        BEDROCK_AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        BEDROCK_AWS_SESSION_TOKEN: credentials.sessionToken,
      }
    case 'cursor':
      return { CURSOR_API_KEY: credentials.apiKey }
  }
}

export function updateProviderEnvContent(
  content: string,
  provider: Exclude<LLMProvider, 'ollama'>,
  credentials?: ProviderCredentials,
): string {
  if (credentials && credentials.provider !== provider) {
    throw new Error('Credential provider does not match the requested provider')
  }
  return replaceEnvValues(
    content,
    PROVIDER_ENV_NAMES[provider],
    credentials ? valuesFor(credentials) : {},
  )
}

function applyToProcessEnv(names: readonly string[], values: Record<string, string | undefined>) {
  for (const name of names) {
    const value = values[name]
    if (value) process.env[name] = value
    else delete process.env[name]
  }
}

export async function saveProviderCredentials(credentials: ProviderCredentials): Promise<void> {
  const names = PROVIDER_ENV_NAMES[credentials.provider]
  const values = valuesFor(credentials)
  credentialWriteQueue = credentialWriteQueue.catch(() => {}).then(async () => {
    const content = updateProviderEnvContent(await readEnvFile(), credentials.provider, credentials)
    await writeEnvFile(content)
    applyToProcessEnv(names, values)
    clearConfigCache()
  })
  return credentialWriteQueue
}

export async function removeProviderCredentials(
  provider: Exclude<LLMProvider, 'ollama'>,
): Promise<void> {
  const names = PROVIDER_ENV_NAMES[provider]
  credentialWriteQueue = credentialWriteQueue.catch(() => {}).then(async () => {
    const content = updateProviderEnvContent(await readEnvFile(), provider)
    await writeEnvFile(content)
    applyToProcessEnv(names, {})
    clearConfigCache()
  })
  return credentialWriteQueue
}

export async function getProviderCredentialStatus(): Promise<
  Record<Exclude<LLMProvider, 'ollama'>, CredentialStatus>
> {
  const names = envNamesInFile(await readEnvFile())
  return {
    google: {
      configured: Boolean(process.env.GOOGLE_API_KEY),
      managedLocally: names.has('GOOGLE_API_KEY'),
    },
    kimi: {
      configured: Boolean(process.env.MOONSHOT_API_KEY ?? process.env.KIMI_API_KEY),
      managedLocally: names.has('MOONSHOT_API_KEY') || names.has('KIMI_API_KEY'),
    },
    bedrock: {
      configured: Boolean(
        (process.env.BEDROCK_AWS_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID) &&
        (process.env.BEDROCK_AWS_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY),
      ),
      managedLocally: PROVIDER_ENV_NAMES.bedrock.some((name) => names.has(name)),
    },
    cursor: {
      configured: Boolean(process.env.CURSOR_API_KEY),
      managedLocally: names.has('CURSOR_API_KEY'),
    },
  }
}

export function withProviderCredentials(
  config: AppConfig,
  credentials: ProviderCredentials,
) {
  switch (credentials.provider) {
    case 'google':
      return { ...config, llm: { ...config.llm, googleApiKey: credentials.apiKey } }
    case 'kimi':
      return {
        ...config,
        llm: {
          ...config.llm,
          kimiApiKey: credentials.apiKey,
          kimiBaseUrl: credentials.baseUrl,
        },
      }
    case 'bedrock':
      return {
        ...config,
        llm: {
          ...config.llm,
          bedrockRegion: credentials.region,
          bedrockAccessKeyId: credentials.accessKeyId,
          bedrockSecretAccessKey: credentials.secretAccessKey,
          bedrockSessionToken: credentials.sessionToken,
        },
      }
    case 'cursor':
      return { ...config, llm: { ...config.llm, cursorApiKey: credentials.apiKey } }
  }
}
