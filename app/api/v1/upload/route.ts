import { workspaceRoute } from '@/lib/local-route'
import { randomUUID } from 'crypto'
import { createUpload, sweepExpiredUploads } from '@/lib/storage/uploads'
import { checkRateLimit, rateLimitSubject } from '@/lib/utils/rate-limit'
import { getActor } from '@/lib/security/actor'
import { parseDocument } from '@/lib/rag/document'

const MAX_SIZE_MB = 10
const ALLOWED_EXTENSIONS = ['.txt', '.md', '.pdf', '.json', '.yaml', '.yml']
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

function getMediaType(filename: string): string {
  const parts = filename.split('.')
  if (parts.length < 2 || (parts.length === 2 && parts[0] === '')) {
    return 'application/octet-stream'
  }
  const ext = parts.pop()!.toLowerCase()
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    yaml: 'application/yaml',
    yml: 'application/yaml',
  }
  return map[ext] || 'application/octet-stream'
}

export const POST = workspaceRoute(async (req) => {
  await sweepExpiredUploads()
  const rateLimit = checkRateLimit(`upload:${rateLimitSubject(req.headers, getActor()?.id)}`, 20, 60_000)
  if (!rateLimit.allowed) {
    return Response.json(
      { error: 'rate_limited', error_description: 'Too many uploads. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } },
    )
  }
  const formData = await req.formData()
  const file = formData.get('file') as File | null

  if (!file) return Response.json({ error: 'No file provided' }, { status: 400 })

  const ext = '.' + file.name.split('.').pop()?.toLowerCase()
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return Response.json(
      { error: `File type not allowed. Supported: ${ALLOWED_EXTENSIONS.join(', ')}` },
      { status: 400 }
    )
  }

  if (file.size > MAX_SIZE_MB * 1024 * 1024) {
    return Response.json({ error: `File too large. Max ${MAX_SIZE_MB}MB` }, { status: 400 })
  }

  let content: string

  if (ext === '.pdf') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>
      const buffer = Buffer.from(await file.arrayBuffer())
      const data = await pdfParse(buffer)
      content = data.text
    } catch {
      return Response.json(
        { error: 'Failed to parse PDF file. File may be corrupted or password-protected.' },
        { status: 400 }
      )
    }
  } else {
    content = await file.text()
    try { parseDocument(content) } catch {
      return Response.json({ error: 'RTF content must be exported as UTF-8 text or Markdown before upload.' }, { status: 400 })
    }
  }

  const uploadId = randomUUID()
  const mediaType = getMediaType(file.name)
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS)

  await createUpload({
    id: uploadId,
    originalName: file.name,
    mediaType,
    content,
    size: file.size,
    expiresAt,
  })

  return Response.json({
    upload_id: uploadId,
    original_name: file.name,
    media_type: mediaType,
    filename: file.name,
    size: file.size,
    extractedLength: content.length,
    expires_at: expiresAt.toISOString(),
  })
})
