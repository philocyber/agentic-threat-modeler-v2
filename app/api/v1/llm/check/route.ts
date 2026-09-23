import { localRoute } from '@/lib/local-route'
import { getConfig } from '@/lib/config'
import { isLLMProvider } from '@/lib/llm/providers'
import { checkProviderKey } from '@/lib/llm/check-key'
import { checkRateLimit } from '@/lib/utils/rate-limit'

/**
 * POST /api/v1/llm/check
 * Smoke-test server-configured credentials for a provider.
 * Body: { provider: 'google' | 'kimi' | 'bedrock' | 'ollama' | 'cursor' }
 *
 * Does NOT accept client-supplied API keys (avoids key exfiltration via the UI).
 */
export const POST = localRoute(async (req) => {
  const rateLimit = checkRateLimit('llm-check:local', 6, 10 * 60 * 1000)
  if (!rateLimit.allowed) {
    return Response.json(
      { error: 'rate_limited', error_description: 'Too many provider checks. Try again later.' },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) },
      }
    )
  }

  let body: { provider?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.provider || !isLLMProvider(body.provider)) {
    return Response.json(
      {
        error: 'invalid_provider',
        error_description: 'provider must be one of: ollama, google, kimi, bedrock, cursor',
      },
      { status: 400 }
    )
  }

  const config = getConfig()
  const result = await checkProviderKey(body.provider, config)

  return Response.json(result, { status: result.ok ? 200 : 422 })
})
