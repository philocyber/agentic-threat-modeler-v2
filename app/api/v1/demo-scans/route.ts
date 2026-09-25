import { workspaceRoute } from '@/lib/local-route'
import { importDemoScans } from '@/lib/demo/import-demo-scans'

export const POST = workspaceRoute(async (_request, { workspace }) => {
  if (!workspace) {
    return Response.json({ error: 'Select a local project to load demo scans.' }, { status: 409 })
  }
  try {
    return Response.json(await importDemoScans())
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : 'Could not load demo scans',
    }, { status: 409 })
  }
})
