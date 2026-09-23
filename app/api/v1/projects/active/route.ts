import { workspaceRoute } from '@/lib/local-route'
import { setActiveProjectCookie } from '@/lib/workspace/request'
import { getLocalProjectById } from '@/lib/workspace/local-project'
import { z } from 'zod'

const SelectProjectSchema = z.object({
  projectId: z.string().uuid().nullable(),
})

export const GET = workspaceRoute(async (_request, { workspace }) => {
  return Response.json({
    data: workspace,
    requiresProject: !workspace && !process.env.DATABASE_URL,
  })
})

export const POST = workspaceRoute(async (request) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = SelectProjectSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'A valid projectId is required' }, { status: 400 })
  }

  const response = Response.json({ data: { projectId: parsed.data.projectId } })
  if (parsed.data.projectId === null) {
    setActiveProjectCookie(response, null)
    return response
  }

  const project = await getLocalProjectById(parsed.data.projectId)
  if (!project) {
    return Response.json({ error: 'Project not found' }, { status: 404 })
  }

  const selected = Response.json({ data: project })
  setActiveProjectCookie(selected, project.id)
  return selected
})
