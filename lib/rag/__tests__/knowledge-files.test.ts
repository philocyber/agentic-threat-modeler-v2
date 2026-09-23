import { describe, expect, it } from 'vitest'
import {
  getKnowledgeDestination,
  KNOWLEDGE_DESTINATIONS,
  sanitizeKnowledgeFilename,
} from '../knowledge-files'

describe('knowledge file boundaries', () => {
  it('reduces uploaded names to a safe leaf filename', () => {
    expect(sanitizeKnowledgeFilename('../../Corporate Policy 2026.md')).toBe('Corporate Policy 2026.md')
    expect(sanitizeKnowledgeFilename('C:\\private\\policy?.yaml')).toBe('policy-.yaml')
    expect(sanitizeKnowledgeFilename('...json')).toBe('document.json')
  })

  it('only resolves declared destinations inside the selected domain', () => {
    expect(getKnowledgeDestination('technical-research', 'technical')?.relativeDirectory).toBe('technical/research')
    expect(getKnowledgeDestination('technical-research', 'corporate')).toBeNull()
    expect(getKnowledgeDestination('../../outside', 'technical')).toBeNull()
    expect(KNOWLEDGE_DESTINATIONS.every((destination) => !destination.relativeDirectory.includes('..'))).toBe(true)
  })

  it('keeps PDF support technical-only until corporate extraction supports it', () => {
    expect(getKnowledgeDestination('technical-general', 'technical')?.allowedExtensions).toContain('.pdf')
    expect(getKnowledgeDestination('corporate-general', 'corporate')?.allowedExtensions).not.toContain('.pdf')
  })
})
