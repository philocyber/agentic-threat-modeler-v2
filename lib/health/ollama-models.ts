export type OllamaModelReadiness = {
  reachable: boolean
  ready: boolean
  availableModels: string[]
  missingModels: string[]
}

function canonicalModel(name: string): string {
  return name.split('/').at(-1)?.includes(':') ? name : `${name}:latest`
}

/** Tags are metadata only: this check never loads, downloads, or invokes a model. */
export async function probeOllamaModels(baseUrl: string, selected: string[]): Promise<OllamaModelReadiness> {
  const requested = [...new Set(selected)]
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000), cache: 'no-store' })
    if (!response.ok) throw new Error('Ollama unavailable')
    const data = await response.json() as { models?: Array<{ name?: string; model?: string; capabilities?: string[] }> }
    if (!Array.isArray(data.models)) throw new Error('Invalid Ollama model inventory')
    const availableModels = data.models
      .filter(model => !model.capabilities || model.capabilities.includes('completion'))
      .map(model => model.name ?? model.model ?? '').filter(Boolean)
    const installed = new Set(availableModels.map(canonicalModel))
    const missingModels = requested.filter(name => !installed.has(canonicalModel(name)))
    return { reachable: true, ready: missingModels.length === 0, availableModels, missingModels }
  } catch {
    return { reachable: false, ready: false, availableModels: [], missingModels: requested }
  }
}
