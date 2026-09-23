import type { NextRequest } from 'next/server'
import { withTelemetrySpan } from '@/lib/observability/telemetry'
import { resolveRequestWorkspace } from '@/lib/workspace/request'
import { runWithWorkspace } from '@/lib/workspace/context'
import type { LocalProject } from '@/lib/workspace/local-project'
import { authorizeApiRequest } from '@/lib/security/service-auth'
import { runWithActor } from '@/lib/security/actor'
import { isTrustedLocalMutation } from '@/lib/security/local-mutation'

/** Matches the context Next.js passes to a route handler (params of a dynamic segment). */
type RouteContext = { params: Promise<Record<string, string>> }

type RouteHandler = (
  request: NextRequest,
  params?: Record<string, string>
) => Promise<Response> | Response

export type WorkspaceRouteHandler = (
  request: NextRequest,
  context: { params: Record<string, string> | undefined; workspace: LocalProject | null }
) => Promise<Response> | Response

/**
 * Wraps API routes with telemetry and service-mode access control.
 * Local workspaces are isolated by project files. Shared Postgres requires
 * bearer tokens in production (`SERVICE_AUTH_TOKENS`).
 */
export function localRoute(
  handler: RouteHandler
): (request: NextRequest, context: RouteContext) => Promise<Response> {
  return workspaceRoute(async (request, context) => handler(request, context.params))
}

/** Global filesystem/provider administration belongs to the local operator.
 * Service bearer tokens authorize analyses, never process-wide configuration.
 */
export function localAdministrationRoute(handler: RouteHandler) {
  return localRoute((request, params) => {
    if (process.env.DATABASE_URL) {
      return Response.json({
        error: 'Local administration is unavailable in service mode. Configure credentials and knowledge through the deployment operator.',
        code: 'LOCAL_ADMINISTRATION_ONLY',
      }, { status: 403 })
    }
    return handler(request, params)
  })
}

export function workspaceRoute(
  handler: WorkspaceRouteHandler
): (request: NextRequest, context: RouteContext) => Promise<Response> {
  return async (request, context) => {
    const params = context?.params ? await context.params : undefined
    // DATABASE_URL selects the shared Postgres backend exclusively. A stale
    // browser cookie or a single residual workspace must never change it.
    const workspace = process.env.DATABASE_URL ? null : await resolveRequestWorkspace(request)
    return withTelemetrySpan(
      `http.${request.method.toLowerCase()}`,
      { method: request.method, mode: 'local', workspaceId: workspace?.id ?? 'postgres' },
      async () => {
        const auth = authorizeApiRequest(request, workspace)
        if (!auth.ok) return auth.response
        const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())
        if (isMutation && auth.actor.kind !== 'token' && !isTrustedLocalMutation(request)) {
          return Response.json(
            { error: 'Local mutations require a loopback, same-origin request.' },
            { status: 403 },
          )
        }
        return runWithActor(auth.actor, () => {
          if (!workspace) return handler(request, { params, workspace: null })
          return runWithWorkspace(workspace, () => handler(request, { params, workspace }))
        })
      },
    )
  }
}
