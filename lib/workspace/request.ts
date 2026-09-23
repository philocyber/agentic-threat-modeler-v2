import type { NextRequest } from 'next/server'
import { getLocalProjectById, listLocalProjects, type LocalProject } from './local-project'

export const ACTIVE_PROJECT_COOKIE = 'agentictm_project'

export function setActiveProjectCookie(response: Response, projectId: string | null): void {
  response.headers.append(
    'Set-Cookie',
    projectId === null
      ? `${ACTIVE_PROJECT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
      : `${ACTIVE_PROJECT_COOKIE}=${projectId}; Path=/; HttpOnly; SameSite=Lax${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`,
  )
}

export async function resolveRequestWorkspace(request: NextRequest): Promise<LocalProject | null> {
  const projectId = request.cookies.get(ACTIVE_PROJECT_COOKIE)?.value
  if (projectId) return getLocalProjectById(projectId)

  // Direct links can be opened before the browser has received the active
  // project cookie. A single local workspace is unambiguous and safe to use;
  // with multiple projects the user must still choose explicitly.
  const projects = await listLocalProjects()
  return projects.length === 1 ? projects[0]! : null
}
