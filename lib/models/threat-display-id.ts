type ThreatIdentityInput = {
  id: string
  title?: string | null | undefined
  component?: string | null | undefined
  description?: string | null | undefined
  strideCategory?: string | null | undefined
  methodology?: string | null | undefined
  owaspCategories?: unknown
}

const CATEGORY_RULES: Array<{ prefix: string; pattern: RegExp }> = [
  { prefix: 'AGE', pattern: /\b(agentic|autonomous agent|multi-agent|tool calling|tool execution)\b/i },
  { prefix: 'AI', pattern: /\b(ai|artificial intelligence|genai|generative ai|llm|model|prompt|rag|embedding|vector)\b/i },
  { prefix: 'IAM', pattern: /\b(auth|authentication|authorization|identity|iam|jwt|oauth|session|credential|password|access control|privilege)\b/i },
  { prefix: 'DAT', pattern: /\b(data|database|sql|postgres|postgresql|mysql|redis|cache|storage|pii|record|encryption at rest)\b/i },
  { prefix: 'INF', pattern: /\b(infrastructure|cloud|kubernetes|container|docker|network|firewall|tls|secret|environment|deployment|server|host)\b/i },
  { prefix: 'SUP', pattern: /\b(supply chain|dependency|package|npm|pnpm|pipeline|ci\/cd|artifact|registry)\b/i },
  { prefix: 'WEB', pattern: /\b(web|frontend|browser|api|gateway|http|https|cors|csrf|xss|endpoint|request|response)\b/i },
]

export function threatCategoryPrefix(threat: ThreatIdentityInput): string {
  const owaspCategories = Array.isArray(threat.owaspCategories)
    ? threat.owaspCategories.filter((value): value is string => typeof value === 'string')
    : []
  const haystack = [
    threat.title,
    threat.component,
    threat.description,
    threat.strideCategory,
    threat.methodology,
    ...owaspCategories,
  ].filter(Boolean).join(' ')

  return CATEGORY_RULES.find(({ pattern }) => pattern.test(haystack))?.prefix ?? 'SEC'
}

export function buildThreatDisplayIdMap<T extends ThreatIdentityInput>(threats: T[]): Map<string, string> {
  const counters = new Map<string, number>()
  return new Map(threats.map((threat) => {
    const prefix = threatCategoryPrefix(threat)
    const sequence = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, sequence)
    return [threat.id, `${prefix}-${String(sequence).padStart(2, '0')}`]
  }))
}

export function withThreatDisplayIds<T extends ThreatIdentityInput>(threats: T[]): Array<T & { displayId: string }> {
  const ids = buildThreatDisplayIdMap(threats)
  return threats.map((threat) => ({ ...threat, displayId: ids.get(threat.id)! }))
}
