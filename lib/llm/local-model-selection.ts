type OllamaModelInventory = {
  reachable: boolean
  availableModels: string[]
  quickModel?: string
  deepModel?: string
}

const HOSTED_MODEL_PATTERNS = [
  /^kimi-/i,
  /^gemini-/i,
  /^models\/gemini-/i,
  /^anthropic\./i,
  /^arn:aws:bedrock:/i,
  /^grok-/i,
]

function isHostedModelId(model: string): boolean {
  return HOSTED_MODEL_PATTERNS.some((pattern) => pattern.test(model))
}

function resolveModel(
  selected: string | undefined,
  fallback: string | undefined,
  availableModels: readonly string[],
): string {
  if (!selected) return fallback ?? ''
  if (availableModels.includes(selected)) return selected
  return isHostedModelId(selected) ? fallback ?? '' : selected
}

/**
 * Repairs provider-switch residue without blocking legitimate custom Ollama IDs.
 * A hosted-looking ID is retained when Ollama actually reports it as installed.
 */
export function resolveOllamaModelSelection(
  selected: { quickModel?: string; deepModel?: string },
  inventory: OllamaModelInventory | undefined,
): { quickModel: string; deepModel: string } {
  if (!inventory?.reachable) {
    return {
      quickModel: selected.quickModel ?? inventory?.quickModel ?? '',
      deepModel: selected.deepModel ?? inventory?.deepModel ?? '',
    }
  }
  return {
    quickModel: resolveModel(selected.quickModel, inventory.quickModel, inventory.availableModels),
    deepModel: resolveModel(selected.deepModel, inventory.deepModel, inventory.availableModels),
  }
}
