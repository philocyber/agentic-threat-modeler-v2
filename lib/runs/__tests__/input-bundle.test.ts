import { describe, expect, it } from 'vitest'
import { fingerprintSystemName, inferSourceInput } from '@/lib/runs/input-bundle'

describe('inferSourceInput', () => {
  it('returns the complete input when no supporting documents were used', () => {
    expect(inferSourceInput('Architecture prompt', [])).toBe('Architecture prompt')
  })

  it('removes appended document extraction from legacy run inputs', () => {
    const effectiveInput = [
      'Architecture prompt',
      '',
      '--- Supporting Document: network.md (text/markdown) ---',
      'Private subnet details',
    ].join('\n')

    expect(inferSourceInput(effectiveInput, [
      { upload_id: 'upload-1', name: 'network.md', type: 'text/markdown' },
    ])).toBe('Architecture prompt')
  })
})

describe('fingerprintSystemName', () => {
  it('keeps the hashed run name after the register title is cleaned', () => {
    expect(fingerprintSystemName(
      'Example Service - Ollama provider debate full run',
      'Example Service (Ollama)',
    )).toBe('Example Service - Ollama provider debate full run')
  })

  it('falls back to the display title when no artifact name exists', () => {
    expect(fingerprintSystemName('  ', 'Example Service')).toBe('Example Service')
  })
})
