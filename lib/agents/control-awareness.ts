import { dreadToPriority } from '@/lib/models/scoring'
import type { ArchitectureData, UnifiedThreat } from '@/lib/models/types'

type ControlRule = { threat: RegExp; control: RegExp; precondition: string; note: string }

const RULES: ControlRule[] = [
  { threat: /sql injection|injection.*(?:database|query)|cwe-?89/i, control: /parameterized|prepared|orm/i, precondition: 'The attacker must reach a query path that bypasses parameterization or uses unsafe raw SQL.', note: 'Parameterized queries are explicitly documented; this is a residual bypass and coverage-verification scenario.' },
  { threat: /jwt|token forgery|authentication bypass/i, control: /jwt validation|jwt verification|signed jwt/i, precondition: 'JWT verification must be bypassed, misconfigured, or inconsistently enforced on a route.', note: 'JWT validation is explicitly documented; validate algorithm, key rotation, issuer, audience, and route coverage.' },
  { threat: /denial of service|resource exhaustion|rate limit|brute force/i, control: /rate limiting/i, precondition: 'The attacker must exceed an unprotected route, identity, tenant, or downstream resource limit.', note: 'Rate limiting is documented; residual risk depends on coverage, distributed bypass, and downstream amplification.' },
  { threat: /plaintext|unencrypted|transport|man.in.the.middle|traffic interception/i, control: /tls transport/i, precondition: 'The attacker must exploit a TLS termination gap, downgrade, certificate-validation flaw, or unencrypted internal hop.', note: 'TLS is explicitly documented; the threat is conditional on an encryption coverage or validation gap.' },
  { threat: /public.*database|direct.*database|internet.*(?:cache|database)|network exposure/i, control: /network isolation/i, precondition: 'The attacker must first gain internal network access or exploit an exposed path that bypasses network isolation.', note: 'Network isolation is documented; direct Internet reachability must not be assumed.' },
  { threat: /webhook|payment request|tamper.*request|third.party request/i, control: /signed external requests/i, precondition: 'Signature validation must be bypassed, replayed, or inconsistently enforced.', note: 'Signed requests are documented; residual risk centers on replay protection, canonicalization, and key management.' },
]

function recalculate(threat: UnifiedThreat, cap: number): UnifiedThreat {
  const dread = {
    ...threat.dread,
    reproducibility: Math.min(threat.dread.reproducibility, cap),
    exploitability: Math.min(threat.dread.exploitability, cap),
    discoverability: Math.min(threat.dread.discoverability, cap + 1),
  }
  dread.total = Math.round(((dread.damage + dread.reproducibility + dread.exploitability + dread.affectedUsers + dread.discoverability) / 5) * 10) / 10
  return { ...threat, dread, priority: dreadToPriority(dread.total) }
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function controlAppliesToThreat(
  control: NonNullable<ArchitectureData['factLedger']>['controls'][number],
  threat: UnifiedThreat,
): boolean {
  if (threat.controlReference && threat.controlReference === control.id) return true
  const controlComponent = normalized(control.component ?? '')
  const threatComponents = [threat.component, ...(threat.traceability?.components ?? [])]
    .map(normalized).filter(Boolean)
  if (controlComponent && threatComponents.some((component) =>
    component === controlComponent || component.includes(controlComponent) || controlComponent.includes(component)
  )) return true
  const configs = (threat.traceability?.securityConfigs ?? []).map(normalized)
  const controlName = normalized(control.name)
  return configs.some((config) => config.includes(controlName) || controlName.includes(config))
}

export function applyControlAwareValidation(
  threats: UnifiedThreat[],
  architecture: ArchitectureData,
  targetThreats: number,
): UnifiedThreat[] {
  const enabledControls = (architecture.factLedger?.controls ?? []).filter((control) => control.status === 'enabled')
  const adjusted = threats.map((threat) => {
    const text = `${threat.title ?? ''} ${threat.description} ${threat.component}`
    const rule = RULES.find((candidate) => candidate.threat.test(text) && enabledControls.some((control) => candidate.control.test(control.name)))
    if (!rule) return { ...threat, disposition: threat.disposition ?? 'applicable' } as UnifiedThreat
    const candidates = enabledControls.filter((item) => rule.control.test(item.name))
    const control = candidates.find((item) => controlAppliesToThreat(item, threat))
    if (!control) {
      return {
        ...threat,
        disposition: 'control_verification_needed' as const,
        residualRiskNotes: `A potentially relevant enabled control exists, but its coverage of ${threat.component} is not documented.`,
      }
    }
    const result = recalculate(threat, 5.5)
    return {
      ...result,
      disposition: 'control_verification_needed' as const,
      preconditions: [...new Set([...(threat.preconditions ?? []), rule.precondition])],
      residualRiskNotes: rule.note,
      controlReference: threat.controlReference ?? control?.id,
      reasoning: [threat.reasoning, `Control-aware validation: ${rule.note}`].filter(Boolean).join('\n'),
    }
  })

  return adjusted
    .filter((threat) => threat.disposition !== 'invalid')
    .sort((left, right) => right.dread.total - left.dread.total)
    .slice(0, Math.max(1, Math.min(targetThreats, 15)))
}
