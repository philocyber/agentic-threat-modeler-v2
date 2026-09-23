/**
 * Server-side smoke checks for configured LLM provider credentials.
 * Never logs full secrets — only prefixes / presence.
 */

import { getModelForProviderRole, isAllowedKimiBaseUrl, type AppConfig } from '@/lib/config'
import type { LLMProvider } from '@/lib/llm/providers'
import { getBedrockCredentials, getBedrockConverseModelId } from '@/lib/llm/bedrock'
import { Agent, Cursor, CursorAgentError } from '@cursor/sdk'
import { buildCursorModelSelection } from '@/lib/llm/cursor'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Defense-in-depth: strip secrets / credential-like tokens from error text. */
function redactSecrets(text: string): string {
  return text
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_KEY]')
    .replace(/\b(sk|rk|key|token|secret|password)[-_a-z0-9]*\s*[:=]\s*\S+/gi, '[REDACTED]')
}

export type KeyCheckResult = {
  ok: boolean
  provider: LLMProvider
  summary: string
  details: string
  hints: string[]
  meta?: Record<string, string | number | boolean | null>
}

function formatHttpError(status: number): { message: string; hints: string[] } {
  const hints: string[] = []
  if (status === 401 || status === 403) {
    hints.push('Credentials were rejected (invalid, expired, or missing permissions).')
  }
  if (status === 404) {
    hints.push('Endpoint or model id may be wrong for this region/account.')
  }
  if (status === 429) {
    hints.push('Rate limited — wait and retry, or check quota/billing.')
  }
  if (status >= 500) {
    hints.push('Provider-side failure — retry later; not necessarily a bad key.')
  }

  // Never return raw provider bodies to API clients.
  const code =
    status === 401 || status === 403
      ? 'invalid_credentials'
      : status === 404
        ? 'model_unavailable'
        : status === 429
          ? 'rate_limited'
          : status >= 500
            ? 'provider_error'
            : 'request_failed'

  return {
    message: `HTTP ${status}: ${code}`,
    hints,
  }
}

function providerErrorSummary(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: unknown; type?: unknown; message?: unknown } | string
      message?: unknown
      code?: unknown
    }
    const error = typeof parsed.error === 'object' && parsed.error !== null
      ? parsed.error
      : undefined
    const code = error?.code ?? error?.type ?? parsed.code
    const message = error?.message ?? parsed.message ?? (
      typeof parsed.error === 'string' ? parsed.error : undefined
    )
    const parts = [code, message]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => redactSecrets(value.trim()).slice(0, 240))
    return parts.length > 0 ? [...new Set(parts)].join(': ') : undefined
  } catch {
    return undefined
  }
}

function modelIdsFromOpenAIList(bodyText: string): string[] {
  try {
    const parsed = JSON.parse(bodyText) as { data?: Array<{ id?: unknown }> }
    return (parsed.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

function modelIdsFromGeminiList(bodyText: string): string[] {
  try {
    const parsed = JSON.parse(bodyText) as { models?: Array<{ name?: unknown }> }
    return (parsed.models ?? [])
      .map((item) => item.name)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.replace(/^models\//, ''))
  } catch {
    return []
  }
}

async function checkGemini(config: AppConfig, model = config.llm.geminiQuickModel): Promise<KeyCheckResult> {
  const provider: LLMProvider = 'google'
  const key = config.llm.googleApiKey
  if (!key) {
    return {
      ok: false,
      provider,
      summary: 'GOOGLE_API_KEY is not configured on the server',
      details:
        'No GOOGLE_API_KEY found in the process environment. Set it in .env.local and restart the app.',
      hints: [
        'Create a key at https://aistudio.google.com/app/apikey',
        'Add GOOGLE_API_KEY=... to .env.local (never commit it)',
        'Restart `pnpm dev` / the container after changing env',
      ],
      meta: { keyPresent: false },
    }
  }

  try {
    const modelsRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      {
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(15_000),
      },
    )
    const modelsBody = await modelsRes.text()
    if (!modelsRes.ok) {
      const { message, hints } = formatHttpError(modelsRes.status)
      const providerError = providerErrorSummary(modelsBody)
      return {
        ok: false,
        provider,
        summary: 'Gemini authentication check failed',
        details: [
          message,
          providerError ? `Provider response: ${providerError}` : undefined,
          'The API key was presented to the official Models endpoint.',
        ].filter(Boolean).join('\n'),
        hints: [
          ...hints,
          'Ensure the Generative Language API is enabled for this Google Cloud project.',
        ],
        meta: {
          model,
          status: modelsRes.status,
          keyPresent: true,
          credentialsValid: false,
          stage: 'model_discovery',
        },
      }
    }

    const availableModels = modelIdsFromGeminiList(modelsBody)
    if (availableModels.length > 0 && !availableModels.includes(model)) {
      return {
        ok: false,
        provider,
        summary: `Gemini credentials are valid, but model "${model}" is unavailable`,
        details: [
          `Configured model: ${model}`,
          `Available Gemini text models: ${availableModels.filter((id) => id.startsWith('gemini-')).slice(0, 20).join(', ')}`,
        ].join('\n'),
        hints: ['Set GEMINI_QUICK_MODEL or GEMINI_DEEP_MODEL to a model returned by models.list.'],
        meta: {
          model,
          status: modelsRes.status,
          keyPresent: true,
          credentialsValid: true,
          stage: 'model_discovery',
        },
      }
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ok' }] }],
        generationConfig: { maxOutputTokens: 128 },
      }),
      signal: AbortSignal.timeout(15_000),
    })

    const bodyText = await res.text()
    if (!res.ok) {
      const { message, hints } = formatHttpError(res.status)
      const providerError = providerErrorSummary(bodyText)
      if (bodyText.toLowerCase().includes('api key not valid')) {
        hints.unshift('Gemini reports the API key as invalid or expired — generate a new one.')
      }
      if (bodyText.toLowerCase().includes('permission') || res.status === 403) {
        hints.push('Ensure the Generative Language API is enabled for this Google Cloud project.')
      }
      return {
        ok: false,
        provider,
        summary: 'Gemini key check failed',
        details: [
          message,
          providerError ? `Provider response: ${providerError}` : undefined,
          `Tried model: ${model}`,
          'API key authentication succeeded on models.list.',
        ].filter(Boolean).join('\n'),
        hints: [
          ...hints,
          'Docs: https://ai.google.dev/gemini-api/docs/api-key',
          `Override model with GEMINI_QUICK_MODEL if "${model}" is unavailable for your key`,
        ],
        meta: { model, status: res.status, keyPresent: true, credentialsValid: true, stage: 'generate_content' },
      }
    }

    return {
      ok: true,
      provider,
      summary: `Gemini OK — model "${model}" accepted a short generateContent call`,
      details: `API key is configured on the server.\nModel: ${model}\nHTTP ${res.status}`,
      hints: [],
      meta: { model, status: res.status, keyPresent: true, credentialsValid: true, stage: 'generate_content' },
    }
  } catch (err) {
    return {
      ok: false,
      provider,
      summary: 'Gemini key check could not reach Google',
      details: redactSecrets(err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
      hints: [
        'Check outbound network / DNS / firewall from this host',
        'Confirm GOOGLE_API_KEY is set and the process was restarted',
      ],
      meta: { keyPresent: true, model, credentialsValid: false, stage: 'network' },
    }
  }
}

async function checkKimi(config: AppConfig, model = config.llm.kimiQuickModel): Promise<KeyCheckResult> {
  const provider: LLMProvider = 'kimi'
  const key = config.llm.kimiApiKey
  const baseUrl = config.llm.kimiBaseUrl.replace(/\/$/, '')

  if (!isAllowedKimiBaseUrl(config.llm.kimiBaseUrl)) {
    return {
      ok: false,
      provider,
      summary: 'KIMI_BASE_URL is not an approved Moonshot API endpoint',
      details: `Configured base URL "${config.llm.kimiBaseUrl}" is not in the allowlist.`,
      hints: [
        'Use https://api.moonshot.ai/v1 or https://api.moonshot.cn/v1',
        'Remove/correct the KIMI_BASE_URL (or MOONSHOT_BASE_URL) env var',
      ],
      meta: { keyPresent: Boolean(key), baseUrl },
    }
  }

  if (!key) {
    return {
      ok: false,
      provider,
      summary: 'MOONSHOT_API_KEY / KIMI_API_KEY is not configured',
      details:
        'Neither MOONSHOT_API_KEY nor KIMI_API_KEY was found. Set one in .env.local and restart.',
      hints: [
        'Create a key at https://platform.kimi.ai (API Keys)',
        'Preferred env: MOONSHOT_API_KEY=...',
        'Optional: KIMI_BASE_URL=https://api.moonshot.ai/v1',
      ],
      meta: { keyPresent: false, baseUrl },
    }
  }

  try {
    const modelsRes = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    })
    const modelsBody = await modelsRes.text()
    if (!modelsRes.ok) {
      const { message, hints } = formatHttpError(modelsRes.status)
      const providerError = providerErrorSummary(modelsBody)
      return {
        ok: false,
        provider,
        summary: 'Kimi / Moonshot authentication check failed',
        details: [
          message,
          providerError ? `Provider response: ${providerError}` : undefined,
          `Base URL: ${baseUrl}`,
          'The API key was presented to the official Models endpoint.',
        ].filter(Boolean).join('\n'),
        hints: [
          ...hints,
          'Confirm the key was created on platform.kimi.ai for the global api.moonshot.ai endpoint.',
          'Keys created for the China platform must use https://api.moonshot.cn/v1.',
        ],
        meta: {
          model,
          status: modelsRes.status,
          baseUrl,
          keyPresent: true,
          credentialsValid: false,
          stage: 'model_discovery',
        },
      }
    }

    const availableModels = modelIdsFromOpenAIList(modelsBody)
    if (availableModels.length > 0 && !availableModels.includes(model)) {
      const kimiModels = availableModels.filter((id) => id.startsWith('kimi-')).slice(0, 12)
      return {
        ok: false,
        provider,
        summary: `Kimi credentials are valid, but model "${model}" is unavailable`,
        details: [
          `Base URL: ${baseUrl}`,
          `Configured model: ${model}`,
          `Available Kimi models: ${kimiModels.join(', ') || '(none returned)'}`,
        ].join('\n'),
        hints: [
          `Set ${model === config.llm.kimiDeepModel ? 'KIMI_DEEP_MODEL' : 'KIMI_QUICK_MODEL'} to a model returned by GET /models.`,
          'Current recommended models are kimi-k2.6 and kimi-k3.',
        ],
        meta: {
          model,
          status: modelsRes.status,
          baseUrl,
          keyPresent: true,
          credentialsValid: true,
          stage: 'model_discovery',
        },
      }
    }

    const isK3 = model === 'kimi-k3' || model.startsWith('kimi-k3-')
    const isK2ReasoningFamily = /^kimi-k2\.(?:5|6)(?:-|$)/.test(model)
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        max_completion_tokens: 256,
        ...(isK3 ? { reasoning_effort: 'low' } : {}),
        ...(isK2ReasoningFamily ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    })

    const bodyText = await res.text()
    if (!res.ok) {
      const { message, hints } = formatHttpError(res.status)
      const providerError = providerErrorSummary(bodyText)
      if (res.status === 401) {
        hints.unshift('Moonshot rejected the bearer token — regenerate MOONSHOT_API_KEY.')
      }
      return {
        ok: false,
        provider,
        summary: 'Kimi / Moonshot model check failed',
        details: [
          message,
          providerError ? `Provider response: ${providerError}` : undefined,
          `Base URL: ${baseUrl}`,
          `Tried model: ${model}`,
          'API key authentication succeeded on GET /models.',
        ].filter(Boolean).join('\n'),
        hints: [
          ...hints,
          'Docs: https://platform.kimi.ai/docs/api/chat',
          'The check uses max_completion_tokens and the model-specific reasoning controls.',
        ],
        meta: {
          model,
          status: res.status,
          baseUrl,
          keyPresent: true,
          credentialsValid: true,
          stage: 'chat_completion',
        },
      }
    }

    return {
      ok: true,
      provider,
      summary: `Kimi OK — model "${model}" accepted a short chat completion`,
      details: `Base URL: ${baseUrl}\nAPI key authentication succeeded.\nModel: ${model}\nHTTP ${res.status}`,
      hints: [],
      meta: {
        model,
        status: res.status,
        baseUrl,
        keyPresent: true,
        credentialsValid: true,
        stage: 'chat_completion',
      },
    }
  } catch (err) {
    return {
      ok: false,
      provider,
      summary: 'Kimi key check could not reach Moonshot',
      details: redactSecrets(err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
      hints: [
        `Could not reach ${baseUrl}`,
        'Check DNS/firewall and KIMI_BASE_URL',
        'Confirm MOONSHOT_API_KEY is set and the process was restarted',
      ],
      meta: {
        keyPresent: true,
        baseUrl,
        model,
        credentialsValid: false,
        stage: 'network',
      },
    }
  }
}

async function checkBedrock(
  config: AppConfig,
  role: 'quick' | 'deep' = 'quick'
): Promise<KeyCheckResult> {
  const provider: LLMProvider = 'bedrock'
  const region = config.llm.bedrockRegion
  const model = getBedrockConverseModelId(config, role)
  const hasExplicitKeys = Boolean(config.llm.bedrockAccessKeyId)

  if (!region) {
    return {
      ok: false,
      provider,
      summary: 'BEDROCK_AWS_REGION / AWS_REGION is not configured',
      details: 'Bedrock requires a region even when using the default AWS credential chain.',
      hints: [
        'Set BEDROCK_AWS_REGION=us-east-1 (or your region)',
        'Enable model access in the Bedrock console for that region',
      ],
      meta: { region: null, keyPresent: hasExplicitKeys },
    }
  }

  try {
    const { BedrockRuntimeClient, ConverseCommand } = await import(
      '@aws-sdk/client-bedrock-runtime'
    )

    const credentials = getBedrockCredentials(config)

    const client = new BedrockRuntimeClient({
      region,
      ...(credentials ? { credentials } : {}),
    })

    const modelId = model

    const out = await client.send(
      new ConverseCommand({
        modelId,
        messages: [
          {
            role: 'user',
            content: [{ text: 'Reply with exactly: ok' }],
          },
        ],
        inferenceConfig: { maxTokens: 16, temperature: 0 },
      })
    )

    const text =
      out.output?.message?.content?.map((c) => ('text' in c ? c.text : '')).join('') ?? ''

    return {
      ok: true,
      provider,
      summary: `Bedrock OK — Converse succeeded for "${modelId}"`,
      details: [
        `Region: ${region}`,
        `Model / profile: ${modelId}`,
        `Credentials: ${hasExplicitKeys ? 'explicit keys' : 'default AWS credential chain'}`,
        `Response preview: ${text.slice(0, 80) || '(empty)'}`,
      ].join('\n'),
      hints: [],
      meta: {
        region,
        model: modelId,
        keyPresent: hasExplicitKeys,
        usedDefaultChain: !hasExplicitKeys,
        credentialsValid: true,
      },
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error'
    const message = redactSecrets(err instanceof Error ? err.message : String(err))
    const credentialFailure = /UnrecognizedClientException|InvalidSignature|ExpiredToken|credentials|Could not load/i.test(
      message + name,
    )
    const hints: string[] = [
      'In Bedrock console → Model access: request/enable the model for this account+region',
      'Confirm IAM allows bedrock:InvokeModel / bedrock:Converse on this model',
      `Verify BEDROCK_QUICK_MODEL / inference profile is valid in ${region}`,
    ]

    if (credentialFailure) {
      hints.unshift('AWS credentials look invalid, expired, or incomplete.')
    }
    if (/AccessDenied|not authorized|Unauthorized/i.test(message)) {
      hints.unshift('IAM policy denied Converse — attach Bedrock invoke permissions.')
    }
    if (/ValidationException|ResourceNotFound|is not authorized|on-demand throughput/i.test(message)) {
      hints.push('Model id may be wrong for the region, or on-demand access is not enabled.')
    }
    if (!hasExplicitKeys) {
      hints.push(
        'No BEDROCK_AWS_ACCESS_KEY_ID/SECRET were set — relying on the default AWS chain (profile/instance role).'
      )
    }

    return {
      ok: false,
      provider,
      summary: 'Bedrock key / credentials check failed',
      details: [
        `${name}: ${message}`,
        `Region: ${region}`,
        `Tried model: ${model}`,
        `Credentials mode: ${hasExplicitKeys ? 'explicit env keys' : 'default AWS chain'}`,
      ].join('\n'),
      hints,
      meta: {
        region,
        model,
        keyPresent: hasExplicitKeys,
        credentialsValid: !credentialFailure,
      },
    }
  }
}

async function checkOllama(config: AppConfig): Promise<KeyCheckResult> {
  const provider: LLMProvider = 'ollama'
  const base = config.llm.ollamaBaseUrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      return {
        ok: false,
        provider,
        summary: 'Ollama is reachable but returned an error',
        details: `HTTP ${res.status} from ${base}/api/tags`,
        hints: ['Is the Ollama daemon running?', `OLLAMA_BASE_URL=${base}`],
      }
    }
    const body = await res.json() as { models?: Array<{ name?: string; model?: string }> }
    const installed = new Set(
      (body.models ?? []).flatMap((item) =>
        [item.name, item.model].filter((name): name is string => Boolean(name)),
      ),
    )
    const required = [...new Set([config.llm.ollamaQuickModel, config.llm.ollamaDeepModel])]
    const missing = required.filter((model) => !installed.has(model))
    if (missing.length > 0) {
      return {
        ok: false,
        provider,
        summary: 'Ollama is reachable, but configured models are missing',
        details: [
          `Missing: ${missing.join(', ')}`,
          `Installed: ${[...installed].slice(0, 30).join(', ') || '(none)'}`,
        ].join('\n'),
        hints: missing.map((model) => `Run: ollama pull ${model}`),
        meta: { baseUrl: base, credentialsValid: true },
      }
    }
    return {
      ok: true,
      provider,
      summary: 'Ollama OK — configured quick and deep models are installed',
      details: `GET ${base}/api/tags → HTTP ${res.status}\nModels: ${required.join(', ')}`,
      hints: [],
      meta: { baseUrl: base, credentialsValid: true },
    }
  } catch (err) {
    return {
      ok: false,
      provider,
      summary: 'Cannot reach Ollama',
      details: redactSecrets(err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
      hints: [
        'Start Ollama locally (`ollama serve`)',
        `Check OLLAMA_BASE_URL (current: ${base})`,
      ],
      meta: { baseUrl: base },
    }
  }
}

function combineModelChecks(
  provider: LLMProvider,
  quick: KeyCheckResult,
  deep: KeyCheckResult
): KeyCheckResult {
  const ok = quick.ok && deep.ok
  const hints = [...new Set([...quick.hints, ...deep.hints])]
  return {
    ok,
    provider,
    summary: ok
      ? `${provider} OK — quick and deep models accepted smoke checks`
      : `${provider} model check failed`,
    details: [
      `Quick model: ${quick.ok ? 'OK' : 'failed'} — ${quick.summary}`,
      quick.details,
      '',
      `Deep model: ${deep.ok ? 'OK' : 'failed'} — ${deep.summary}`,
      deep.details,
    ].join('\n'),
    hints,
    meta: {
      quickModel: quick.meta?.model ?? null,
      deepModel: deep.meta?.model ?? null,
      quickOk: quick.ok,
      deepOk: deep.ok,
      credentialsValid:
        quick.meta?.credentialsValid === true || deep.meta?.credentialsValid === true,
      quickStatus: quick.meta?.status ?? null,
      deepStatus: deep.meta?.status ?? null,
    },
  }
}

async function checkCursor(config: AppConfig): Promise<KeyCheckResult> {
  const provider: LLMProvider = 'cursor'
  const key = config.llm.cursorApiKey
  const quickModel = getModelForProviderRole('cursor', 'quick', config)
  const deepModel = getModelForProviderRole('cursor', 'deep', config)

  if (!key) {
    return {
      ok: false,
      provider,
      summary: 'CURSOR_API_KEY is not configured on the server',
      details:
        'No CURSOR_API_KEY found in the process environment. Set it in .env.local and restart the app.',
      hints: [
        'Create a user or service-account key at https://cursor.com/dashboard/integrations',
        'Add CURSOR_API_KEY=... to .env.local (never commit it)',
        'Restart `pnpm dev` after changing env',
      ],
      meta: { keyPresent: false },
    }
  }

  let cwd: string | undefined
  try {
    const models = await Cursor.models.list({ apiKey: key })
    const ids = new Set(models.flatMap((m) => [m.id, ...(m.aliases ?? [])]))
    const wanted = [...new Set([quickModel, deepModel])]
    const missing = wanted.filter((id) => !ids.has(id))
    if (missing.length > 0) {
      return {
        ok: false,
        provider,
        summary: 'Cursor catalog does not include the configured model',
        details: `Missing model id(s): ${missing.join(', ')}`,
        hints: [
          'This API key cannot use the configured CURSOR_QUICK_MODEL / CURSOR_DEEP_MODEL',
          'Grok 4.7 is in the Cursor Models pool — confirm the account and team have access',
        ],
        meta: { keyPresent: true, quickModel, deepModel },
      }
    }

    cwd = await mkdtemp(join(tmpdir(), 'agentictm-cursor-check-'))
    const result = await Agent.prompt('Reply with exactly: ok', {
      apiKey: key,
      model: buildCursorModelSelection(quickModel, config.llm.cursorQuickFast),
      tools: [],
      local: { cwd, settingSources: [] },
    })

    if (result.status === 'error' || result.status === 'cancelled') {
      return {
        ok: false,
        provider,
        summary: 'Cursor smoke prompt failed',
        details: result.error?.message ?? `Run status: ${result.status}`,
        hints: [
          'Confirm CURSOR_API_KEY is valid',
          'Local Cursor agent runtime must be able to start on this host',
        ],
        meta: { keyPresent: true, model: quickModel, runStatus: result.status },
      }
    }

    return {
      ok: true,
      provider,
      summary: `Cursor OK — catalog includes ${wanted.join(', ')} and a text-only prompt succeeded`,
      details: `Model: ${quickModel}\nRun status: ${result.status}`,
      hints: [],
      meta: { keyPresent: true, model: quickModel, status: result.status },
    }
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    const hints = [
      'Confirm CURSOR_API_KEY and outbound access to Cursor',
      'Local agents require the Cursor runtime on this machine',
    ]
    if (err instanceof CursorAgentError && /401|auth/i.test(message)) {
      hints.unshift('Cursor rejected the API key.')
    }
    return {
      ok: false,
      provider,
      summary: 'Cursor check failed',
      details: message,
      hints,
      meta: { keyPresent: true, model: quickModel },
    }
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

export async function checkProviderKey(
  provider: LLMProvider,
  config: AppConfig
): Promise<KeyCheckResult> {
  switch (provider) {
    case 'google': {
      const quickModel = getModelForProviderRole(provider, 'quick', config)
      const deepModel = getModelForProviderRole(provider, 'deep', config)
      const quick = await checkGemini(config, quickModel)
      if (quickModel === deepModel) return quick
      return combineModelChecks(provider, quick, await checkGemini(config, deepModel))
    }
    case 'kimi': {
      const quickModel = getModelForProviderRole(provider, 'quick', config)
      const deepModel = getModelForProviderRole(provider, 'deep', config)
      const quick = await checkKimi(config, quickModel)
      if (quickModel === deepModel) return quick
      return combineModelChecks(provider, quick, await checkKimi(config, deepModel))
    }
    case 'bedrock': {
      const quick = await checkBedrock(config, 'quick')
      // Skip the redundant second call whenever the actual Converse `modelId`
      // used would be identical either way (always true with a profile set,
      // since it overrides both roles; otherwise when quick/deep resolve to
      // the same underlying model id).
      const quickModelId = getBedrockConverseModelId(config, 'quick')
      const deepModelId = getBedrockConverseModelId(config, 'deep')
      if (quickModelId === deepModelId) return quick
      return combineModelChecks(provider, quick, await checkBedrock(config, 'deep'))
    }
    case 'cursor':
      return checkCursor(config)
    case 'ollama':
      return checkOllama(config)
    default:
      return {
        ok: false,
        provider,
        summary: `Unsupported provider: ${provider}`,
        details: '',
        hints: [],
      }
  }
}
