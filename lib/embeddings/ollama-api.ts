type OllamaErrorBody = {
  error?: unknown
}

type OllamaEmbedBody = {
  embeddings?: unknown
}

type OllamaPullBody = {
  completed?: unknown
  error?: unknown
  status?: unknown
  total?: unknown
}

export type OllamaPullProgress = {
  completed: number | null
  status: string
  total: number | null
}

export class OllamaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(message)
    this.name = 'OllamaApiError'
  }
}

function endpoint(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${pathname}`
}

async function responseDetail(response: Response): Promise<string> {
  const body = await response.text()
  if (body) {
    try {
      const parsed = JSON.parse(body) as OllamaErrorBody
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim()
    } catch {
      // Ollama proxies can return plain-text errors. Preserve those too.
    }
    if (body.trim()) return body.trim()
  }
  return response.statusText || `HTTP ${response.status}`
}

async function throwApiError(response: Response, action: string): Promise<never> {
  const detail = await responseDetail(response)
  throw new OllamaApiError(`Ollama ${action} failed: ${detail}`, response.status, detail)
}

export function isMissingOllamaModelError(error: unknown): error is OllamaApiError {
  return error instanceof OllamaApiError
    && error.status === 404
    && /model.+not found|try pulling it first/i.test(error.detail)
}

export function formatOllamaRetrievalQuery(model: string, query: string): string {
  if (!/qwen3-embedding/i.test(model)) return query
  return [
    'Instruct: Given a cybersecurity analysis query, retrieve the most relevant technical or corporate evidence.',
    `Query: ${query}`,
  ].join('\n')
}

export async function embedWithOllama(
  baseUrl: string,
  model: string,
  texts: string[],
  timeoutMs = 120_000,
): Promise<number[][]> {
  if (texts.length === 0) return []
  const response = await fetch(endpoint(baseUrl, '/api/embed'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Preserve the complete chunk, including qualifications and metadata. Let
    // Ollama reject context overflow instead of silently embedding a prefix.
    body: JSON.stringify({ model, input: texts, truncate: false }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) await throwApiError(response, 'embed')

  const data = await response.json() as OllamaEmbedBody
  if (!Array.isArray(data.embeddings)
    || data.embeddings.length !== texts.length
    || data.embeddings.some((embedding) => !Array.isArray(embedding) || embedding.length === 0
      || embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))
      || embedding.length !== (data.embeddings as unknown[][])[0]?.length)) {
    throw new Error('Ollama embed returned mismatched embeddings')
  }
  return data.embeddings as number[][]
}

export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void,
  timeoutMs = 2 * 60 * 60_000,
): Promise<void> {
  const response = await fetch(endpoint(baseUrl, '/api/pull'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) await throwApiError(response, `model pull for "${model}"`)

  if (!response.body) throw new Error(`Ollama model pull for "${model}" returned no progress stream`)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalStatus = ''

  const handleLine = (line: string): void => {
    if (!line.trim()) return
    const data = JSON.parse(line) as OllamaPullBody
    if (typeof data.error === 'string' && data.error.trim()) {
      throw new Error(`Ollama model pull for "${model}" failed: ${data.error.trim()}`)
    }
    if (typeof data.status !== 'string') return
    finalStatus = data.status
    onProgress?.({
      completed: typeof data.completed === 'number' ? data.completed : null,
      status: data.status,
      total: typeof data.total === 'number' ? data.total : null,
    })
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
    if (done) break
  }
  handleLine(buffer)

  if (finalStatus !== 'success') {
    throw new Error(`Ollama model pull for "${model}" did not complete successfully`)
  }
}
