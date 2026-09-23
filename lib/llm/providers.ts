/**
 * Shared LLM provider identifiers and model resolution helpers.
 */

export const LLM_PROVIDERS = ['ollama', 'google', 'kimi', 'bedrock', 'cursor'] as const
export type LLMProvider = (typeof LLM_PROVIDERS)[number]

export type LLMRole = 'quick' | 'deep' | 'stride'

export const PROVIDER_METADATA: Record<LLMProvider, { label: string; privacy: string }> = {
  ollama: { label: 'Ollama', privacy: 'Local inference; prompts stay on the configured Ollama host.' },
  google: { label: 'Google Gemini', privacy: 'Cloud inference; verify data handling and ZDR terms.' },
  kimi: { label: 'Kimi / Moonshot', privacy: 'Cloud inference; use sensitive data only under approved handling terms.' },
  bedrock: { label: 'AWS Bedrock', privacy: 'Cloud inference in the configured AWS region and account boundary.' },
  cursor: { label: 'Cursor', privacy: 'Cloud agent inference; prompts are sent through the Cursor SDK with tools disabled.' },
}

export const DEFAULT_PROVIDER_MODELS: Record<LLMProvider, { quick: string; deep: string }> = {
  ollama: { quick: 'qwen3.5:4b', deep: 'qwen3.5:9b' },
  google: { quick: 'gemini-3.5-flash-lite', deep: 'gemini-3.1-pro-preview' },
  kimi: { quick: 'kimi-k2.6', deep: 'kimi-k3' },
  bedrock: {
    quick: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    deep: 'anthropic.claude-sonnet-5',
  },
  cursor: { quick: 'grok-4.7', deep: 'grok-4.7' },
}

export function isLLMProvider(value: unknown): value is LLMProvider {
  return typeof value === 'string' && (LLM_PROVIDERS as readonly string[]).includes(value)
}
