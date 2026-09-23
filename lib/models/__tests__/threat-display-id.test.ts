import { describe, expect, it } from 'vitest'
import { threatCategoryPrefix, withThreatDisplayIds } from '../threat-display-id'

describe('threat display IDs', () => {
  it('classifies common product security domains', () => {
    expect(threatCategoryPrefix({ id: '1', component: 'API Gateway', description: 'CORS weakness' })).toBe('WEB')
    expect(threatCategoryPrefix({ id: '2', component: 'PostgreSQL', description: 'Sensitive records exposed' })).toBe('DAT')
    expect(threatCategoryPrefix({ id: '3', component: 'Agent runtime', description: 'Autonomous agent invokes unsafe tools' })).toBe('AGE')
    expect(threatCategoryPrefix({ id: '4', component: 'LLM service', description: 'Prompt injection' })).toBe('AI')
  })

  it('numbers each category independently and preserves internal IDs', () => {
    const threats = withThreatDisplayIds([
      { id: 'uuid-a', component: 'Browser', description: 'XSS' },
      { id: 'uuid-b', component: 'API', description: 'HTTP request smuggling' },
      { id: 'uuid-c', component: 'Redis', description: 'Session records exposed' },
    ])

    expect(threats.map((threat) => [threat.id, threat.displayId])).toEqual([
      ['uuid-a', 'WEB-01'],
      ['uuid-b', 'WEB-02'],
      ['uuid-c', 'IAM-01'],
    ])
  })
})
