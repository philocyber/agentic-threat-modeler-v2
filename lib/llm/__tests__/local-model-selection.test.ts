import { describe, expect, it } from 'vitest'
import { resolveOllamaModelSelection } from '../local-model-selection'

const inventory = {
  reachable: true,
  availableModels: ['qwen3:4b', 'qwen3:8b'],
  quickModel: 'qwen3:4b',
  deepModel: 'qwen3:8b',
}

describe('resolveOllamaModelSelection', () => {
  it('replaces stale Kimi values with the configured local models', () => {
    expect(resolveOllamaModelSelection({
      quickModel: 'kimi-k2.6',
      deepModel: 'kimi-k3',
    }, inventory)).toEqual({
      quickModel: 'qwen3:4b',
      deepModel: 'qwen3:8b',
    })
  })

  it('preserves installed selections and custom local model IDs', () => {
    expect(resolveOllamaModelSelection({
      quickModel: 'qwen3:8b',
      deepModel: 'team/security-model:latest',
    }, inventory)).toEqual({
      quickModel: 'qwen3:8b',
      deepModel: 'team/security-model:latest',
    })
  })

  it('allows a hosted-looking name when Ollama reports it as installed', () => {
    expect(resolveOllamaModelSelection({ deepModel: 'kimi-k3' }, {
      ...inventory,
      availableModels: [...inventory.availableModels, 'kimi-k3'],
    }).deepModel).toBe('kimi-k3')
  })
})
