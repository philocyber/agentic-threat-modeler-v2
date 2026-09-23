import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import type { LocalProject } from '@/lib/workspace/local-project'
import type { RequestActor } from '@/lib/security/actor'

const PUBLIC_PATHS = new Set(['/api/health'])

export type AuthResult =
  | { ok: true; actor: RequestActor }
  | { ok: false; response: Response }

function serviceAuthRequired(): boolean {
  const explicit = process.env.SERVICE_AUTH_REQUIRED?.trim().toLowerCase()
  if (explicit === 'true' || explicit === '1' || explicit === 'yes' || explicit === 'on') return true
  if (explicit === 'false' || explicit === '0' || explicit === 'no' || explicit === 'off') return false
  return process.env.NODE_ENV === 'production'
}

function configuredTokens(): string[] {
  return (process.env.SERVICE_AUTH_TOKENS ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
}

function principalIdForToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

function tokensEqual(provided: string, expected: string): boolean {
  const left = createHash('sha256').update(provided).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const [scheme, token] = header.split(/\s+/, 2)
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null
  return token.trim() || null
}

function matchToken(provided: string, tokens: string[]): string | null {
  for (const expected of tokens) {
    if (tokensEqual(provided, expected)) return principalIdForToken(expected)
  }
  return null
}

/**
 * Local workspaces stay cookie/filesystem isolated. Shared Postgres (no
 * workspace + DATABASE_URL) is fail-closed in production unless bearer tokens
 * are configured, and token principals cannot read each other's records.
 *
 * On a Postgres deployment with tokens configured, a resolved local workspace
 * must not bypass bearer auth: one leftover project directory would otherwise
 * disable authentication for the whole API, so the token check runs first.
 */
export function authorizeApiRequest(
  request: NextRequest,
  workspace: LocalProject | null,
): AuthResult {
  if (PUBLIC_PATHS.has(request.nextUrl.pathname)) {
    return { ok: true, actor: { id: 'health', kind: 'local' } }
  }

  const tokens = configuredTokens()
  const serviceMode = Boolean(process.env.DATABASE_URL)

  if (!serviceMode && workspace) {
    return { ok: true, actor: { id: `ws:${workspace.id}`, kind: 'workspace' } }
  }

  if (!process.env.DATABASE_URL) {
    return { ok: true, actor: { id: 'local', kind: 'local' } }
  }

  if (tokens.length === 0) {
    if (serviceAuthRequired()) {
      return {
        ok: false,
        response: Response.json(
          { error: 'Service authentication is not configured.' },
          { status: 503 },
        ),
      }
    }
    return { ok: true, actor: { id: 'local-dev', kind: 'local' } }
  }

  const provided = bearerToken(request)
  if (!provided) {
    return { ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const principalId = matchToken(provided, tokens)
  if (!principalId) {
    return { ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  return { ok: true, actor: { id: principalId, kind: 'token' } }
}
