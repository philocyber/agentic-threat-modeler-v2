import { localAdministrationRoute, localRoute } from '@/lib/local-route'
import {
  getKnowledgeDestination,
  KNOWLEDGE_DESTINATIONS,
  listKnowledgeFiles,
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_KNOWLEDGE_FILES_PER_UPLOAD,
  saveKnowledgeFiles,
} from '@/lib/rag/knowledge-files'

export const runtime = 'nodejs'

export const GET = localRoute(async () => Response.json({
  files: await listKnowledgeFiles(),
  destinations: KNOWLEDGE_DESTINATIONS,
  limits: {
    maxFiles: MAX_KNOWLEDGE_FILES_PER_UPLOAD,
    maxFileBytes: MAX_KNOWLEDGE_FILE_BYTES,
  },
}))

export const POST = localAdministrationRoute(async (request) => {
  try {
    const formData = await request.formData()
    const domain = String(formData.get('domain') ?? '')
    const destinationId = String(formData.get('destination') ?? '')
    const destination = getKnowledgeDestination(destinationId, domain)
    if (!destination) return Response.json({ error: 'Select a valid knowledge destination.' }, { status: 400 })
    const files = formData.getAll('files').filter((value): value is File => value instanceof File)
    const saved = await saveKnowledgeFiles({
      destination,
      files,
      replaceExisting: formData.get('replaceExisting') === 'true',
    })
    return Response.json({ saved, message: `${saved.length} document${saved.length === 1 ? '' : 's'} added. Reindex to make the new evidence searchable.` }, { status: 201 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Knowledge upload failed' }, { status: 400 })
  }
})
