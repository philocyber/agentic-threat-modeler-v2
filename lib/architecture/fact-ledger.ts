import type { ArchitectureData } from '@/lib/db/schema'

type Ledger = NonNullable<ArchitectureData['factLedger']>
type LedgerControl = Ledger['controls'][number]
const UNVERIFIED_CONTROL = /\b(?:unknown|unverified|unspecified|unconfirmed|intended|documented|planned|proposed|recommended|should|must|future|not (?:evidenced|documented|verified|confirmed|specified)|no evidence|to (?:verify|confirm|implement))\b|desconocid[oa]|por verificar/i

export function configurationStatus(details: string, isEnabled: boolean): LedgerControl['status'] {
  if (UNVERIFIED_CONTROL.test(details)) return 'unknown'
  if (isEnabled) return 'enabled'
  return /\b(?:disabled|absent|not implemented|without)\b/i.test(details) ? 'disabled' : 'unknown'
}

const CONTROL_PATTERNS: Array<{
  name: string
  pattern: RegExp
  disabled?: RegExp
}> = [
  { name: 'TLS transport encryption', pattern: /\b(?:https|tls|m?tls)\b/i, disabled: /\b(?:without|no|disable[ds]?)\s+(?:https|tls|m?tls)\b/i },
  { name: 'Parameterized database queries', pattern: /\b(?:parameteri[sz]ed (?:queries|statements)|prepared statements?|orm)\b/i, disabled: /\b(?:raw queries?|string concatenation)\b/i },
  { name: 'JWT validation', pattern: /\b(?:jwt (?:validation|verification)|verify (?:the )?jwt|signed jwt)\b/i, disabled: /\b(?:jwt (?:validation|verification) (?:is )?disabled|unsigned jwt)\b/i },
  { name: 'Rate limiting', pattern: /\b(?:rate[- ]limit(?:ing)?|requests? per (?:second|minute|hour))\b/i, disabled: /\b(?:no|without|disabled?) rate[- ]limit/i },
  { name: 'Least privilege', pattern: /\b(?:least privilege|read[- ]only|scoped (?:role|permission)|rbac)\b/i, disabled: /\b(?:admin|root|superuser) (?:role|access|credential)/i },
  { name: 'Network isolation', pattern: /\b(?:private (?:subnet|network|cluster)|vpc|internal only|not internet[- ]facing)\b/i, disabled: /\b(?:publicly accessible|directly exposed to (?:the )?internet|public subnet)\b/i },
  { name: 'Encryption at rest', pattern: /\b(?:encrypt(?:ed|ion) at rest|disk encryption|kms)\b/i, disabled: /\b(?:unencrypted|plaintext storage)\b/i },
  { name: 'Access control lists', pattern: /\b(?:acl|access control list|firewall allowlist)\b/i, disabled: /\b(?:no acl|acl disabled|allow all)\b/i },
  { name: 'Signed external requests', pattern: /\b(?:signed (?:request|webhook|payment)|hmac)\b/i, disabled: /\b(?:unsigned (?:request|webhook)|signature validation disabled)\b/i },
  { name: 'Audit logging', pattern: /\b(?:audit log(?:ging)?|security log(?:ging)?|siem)\b/i, disabled: /\b(?:logging disabled|no audit log)\b/i },
]

function sentences(input: string): string[] {
  return input
    .replace(/\r/g, '')
    // Links identify sources; their URL scheme is not a transport control.
    .replace(/^\s*(?:[-*]\s*)?(?:\[[^\]]*\]\(https?:\/\/[^)]+\)\s*)+$/gm, '')
    .replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 12 && !/^(?:#{1,6}\s|---|```|\[?\d+\]?\s*$)/.test(value))
}

function categoryFor(text: string): Ledger['sourceFacts'][number]['category'] {
  if (/\b(?:encrypt|auth|jwt|rate|acl|firewall|control|validat|signed|rbac|tls|https)\b/i.test(text)) return 'control'
  if (/\b(?:data|pii|payment|transaction|record|database|cache|store)\b/i.test(text)) return 'data'
  if (/\b(?:internet|public|private|dmz|internal|boundary|external)\b/i.test(text)) return 'boundary'
  return 'architecture'
}

function componentFor(text: string, architecture: ArchitectureData): string | undefined {
  return architecture.components.find((component) =>
    text.toLowerCase().includes(component.name.toLowerCase()) ||
    Boolean(component.technology && text.toLowerCase().includes(component.technology.toLowerCase())),
  )?.name
}

export function buildArchitectureFactLedger(rawInput: string, architecture: ArchitectureData): Ledger {
  const facts = sentences(architecture.sourceEvidence ? architecture.sourceEvidence.sections.map(section => section.text).join('') : rawInput)
  const controls: LedgerControl[] = []
  for (const definition of CONTROL_PATTERNS) {
    const matches = facts.filter((fact) => definition.pattern.test(fact) || definition.disabled?.test(fact))
    for (const evidence of [...new Set(matches)]) controls.push({
      id: `CTRL-${String(controls.length + 1).padStart(2, '0')}`,
      name: definition.name,
      status: UNVERIFIED_CONTROL.test(evidence) ? 'unknown' : definition.disabled?.test(evidence) ? 'disabled' : 'enabled',
      component: componentFor(evidence, architecture),
      evidence,
    })
  }

  for (const config of architecture.detailedTopology?.securityConfigs ?? []) {
    const duplicate = controls.some((control) => control.evidence === config.details)
    if (duplicate) continue
    controls.push({
      id: `CTRL-${String(controls.length + 1).padStart(2, '0')}`,
      name: config.configType || 'Security configuration',
      status: configurationStatus(config.details, config.isEnabled),
      component: config.component,
      evidence: config.details,
    })
  }

  // Conflicting claims on the same named component require verification. Never
  // let the first enabled claim silently reduce risk against later counterevidence.
  const conflicts = controls.filter(control => controls.some(other =>
    other.name === control.name && other.component === control.component &&
    control.status !== 'unknown' && other.status !== 'unknown' && other.status !== control.status))
  for (const control of conflicts) control.status = 'unknown'

  // Bound prompt size while sampling the whole input, never only its opening.
  // Control extraction above still scans every statement. IDs retain source order.
  const factBudget = architecture.sourceEvidence ? Number.POSITIVE_INFINITY : 160
  const selectedIndices = new Set<number>()
  const sample = (indices: number[], budget: number) => {
    for (let i = 0; i < Math.min(budget, indices.length); i++) selectedIndices.add(indices[Math.floor(i * indices.length / Math.min(budget, indices.length))]!)
  }
  if (facts.length <= factBudget) facts.forEach((_, i) => selectedIndices.add(i))
  else {
    sample(facts.map((_, i) => i), 120)
    sample(facts.flatMap((fact, i) => /control|validat|permission|credential|boundary|unverified|unconfirmed|confinement|approval|access/i.test(fact) ? [i] : []), 40)
  }
  const inputLower = rawInput.toLowerCase()
  const assumptions = architecture.components
    .filter((component) => !inputLower.includes(component.name.toLowerCase()) &&
      !(component.technology && inputLower.includes(component.technology.toLowerCase())))
    .map((component) => `Parsed component not named verbatim in source: ${component.name}`)

  return {
    sourceFacts: facts.flatMap((text, index) => selectedIndices.has(index) ? [{ id: `FACT-${String(index + 1).padStart(2, '0')}`, text, category: categoryFor(text) }] : []),
    controls,
    assets: [...new Set([
      ...architecture.dataStores,
      ...facts.filter((fact) => /\b(?:pii|payment|transaction|credential|token|customer|account)\b/i.test(fact)).map((fact) => fact.slice(0, 120)),
    ])].slice(0, 20),
    assumptions: [...assumptions.slice(0, 20), ...(facts.length > selectedIndices.size ? [`Source fact excerpt: ${selectedIndices.size} of ${facts.length} statements, sampled across the full input. All statements were scanned for controls. Unlisted facts are not evidence of absence.`] : [])],
  }
}

export function attachArchitectureFactLedger(rawInput: string, architecture: ArchitectureData): ArchitectureData {
  return { ...architecture, factLedger: buildArchitectureFactLedger(rawInput, architecture) }
}
