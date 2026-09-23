import { localRoute } from '@/lib/local-route'
import { createLocalProject, listLocalProjects } from '@/lib/workspace/local-project'
import { setActiveProjectCookie } from '@/lib/workspace/request'

export const GET = localRoute(async () => {
  const projects = await listLocalProjects()
  return Response.json({ data: projects })
})

export const POST = localRoute(async (request) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const project = await createLocalProject(body)
    const response = Response.json({ data: project }, { status: 201 })
    setActiveProjectCookie(response, project.id)
    return response
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return Response.json({ error: 'Project name must be between 1 and 120 characters' }, { status: 400 })
    }
    throw error
  }
})
