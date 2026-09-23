import { z } from 'zod'
import { localAdministrationRoute, localRoute } from '@/lib/local-route'
import { getConfig } from '@/lib/config'
import { checkProviderKey } from '@/lib/llm/check-key'
import {
  getProviderCredentialStatus,
  removeProviderCredentials,
  saveProviderCredentials,
  withProviderCredentials,
  type ProviderCredentials,
} from '@/lib/llm/provider-credentials'
import { checkRateLimit } from '@/lib/utils/rate-limit'

const secret = z.string().trim().min(8).max(4096)
const credentialsSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('google'), apiKey: secret }),
  z.object({
    provider: z.literal('kimi'),
    apiKey: secret,
    baseUrl: z.enum(['https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1']),
  }),
  z.object({
    provider: z.literal('bedrock'),
    region: z.string().trim().min(3).max(64),
    accessKeyId: secret.max(256),
    secretAccessKey: secret,
    sessionToken: z.string().trim().max(4096).optional(),
  }),
  z.object({ provider: z.literal('cursor'), apiKey: secret }),
])

const providerSchema = z.enum(['google', 'kimi', 'bedrock', 'cursor'])

function noStore(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  headers.set('Cache-Control', 'no-store')
  return Response.json(body, { ...init, headers })
}

export const GET = localRoute(async () => {
  return noStore({ providers: await getProviderCredentialStatus(), readOnly: process.env.CREDENTIALS_READ_ONLY === 'true' })
})

export const PUT = localAdministrationRoute(async (req) => {
  if (process.env.CREDENTIALS_READ_ONLY === 'true') {
    return noStore({ error: 'externally_managed', error_description: 'Configure credentials through the container environment.' }, { status: 403 })
  }

  const rateLimit = checkRateLimit('llm-credentials:local', 6, 10 * 60 * 1000)
  if (!rateLimit.allowed) {
    return noStore(
      { error: 'rate_limited', error_description: 'Too many credential checks. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } },
    )
  }

  let input: unknown
  try {
    input = await req.json()
  } catch {
    return noStore({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = credentialsSchema.safeParse(input)
  if (!parsed.success) {
    return noStore(
      { error: 'invalid_credentials', error_description: 'Complete the required credential fields.' },
      { status: 400 },
    )
  }

  const credentials = parsed.data as ProviderCredentials
  const check = await checkProviderKey(
    credentials.provider,
    withProviderCredentials(getConfig(), credentials),
  )
  const credentialsValid = check.meta?.credentialsValid === true
  if (!check.ok && !credentialsValid) {
    return noStore({ saved: false, check }, { status: 422 })
  }

  await saveProviderCredentials(credentials)
  return noStore({
    saved: true,
    check: check.ok
      ? check
      : {
          ...check,
          summary: `Credential saved, but provider readiness failed: ${check.summary}`,
        },
    providers: await getProviderCredentialStatus(),
  }, { status: check.ok ? 200 : 202 })
})

export const DELETE = localAdministrationRoute(async (req) => {
  if (process.env.CREDENTIALS_READ_ONLY === 'true') {
    return noStore({ error: 'externally_managed', error_description: 'Configure credentials through the container environment.' }, { status: 403 })
  }

  let input: unknown
  try {
    input = await req.json()
  } catch {
    return noStore({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = z.object({ provider: providerSchema }).safeParse(input)
  if (!parsed.success) return noStore({ error: 'invalid_provider' }, { status: 400 })

  const status = await getProviderCredentialStatus()
  if (!status[parsed.data.provider].managedLocally) {
    return noStore(
      { error: 'externally_managed', error_description: 'This credential is managed outside the UI.' },
      { status: 409 },
    )
  }

  await removeProviderCredentials(parsed.data.provider)
  return noStore({ removed: true, providers: await getProviderCredentialStatus() })
})
