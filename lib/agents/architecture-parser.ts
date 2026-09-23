import { isProviderBillingError } from '@/lib/llm/provider-errors'
import { createSourceEvidence, formatSourceSections, packSourceSections, sourceCharacterBudget } from '@/lib/architecture/source-evidence'
import { z } from 'zod'
import { invokeWithRetry, mapWithConcurrency } from './base'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ArchitectureData } from '@/lib/models/types'
import { redactArchitectureSecrets } from '@/lib/utils/redact'
import { buildArchitectureMermaid } from '@/lib/architecture/mermaid'
import {
  mergePartialArchitectures,
  resolveArchitectureChunkConcurrency,
  type PartialArchitecture,
} from '@/lib/architecture/input-chunking'
import { agentLog } from './logger'
import { providerNameOf } from '@/lib/llm/usage'

const TechFlagsSchema = z.object({
  hasAI: z.boolean(),
  hasMicroservices: z.boolean(),
  hasKubernetes: z.boolean(),
  hasAuthSystem: z.boolean(),
  hasExternalIntegrations: z.boolean(),
  hasDatabaseLayer: z.boolean(),
  hasFileStorage: z.boolean(),
  hasMessageQueue: z.boolean(),
})

// Enhanced topology schemas from SKILL integration
const ActorSchema = z.object({
  name: z.string(),
  description: z.string(),
  privilegeLevel: z.string(),  // "admin" | "user" | "public" | "service"
  reference: z.string().optional(),
})

const EnvironmentVarSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  isSensitive: z.boolean(),
  component: z.string(),
})

const SecurityConfigSchema = z.object({
  component: z.string(),
  configType: z.string(),
  isEnabled: z.boolean(),
  details: z.string(),
})

const DetailedTopologySchema = z.object({
  actors: z.array(ActorSchema).optional(),
  environmentVars: z.array(EnvironmentVarSchema).optional(),
  securityConfigs: z.array(SecurityConfigSchema).optional(),
}).optional()

const VALID_SCOPES = ['internal', 'dmz', 'public', 'cloud', 'external'] as const

const ComponentSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const o = val as Record<string, unknown>
    const rawScope = String(o.scope ?? 'internal').toLowerCase()
    const scope = (VALID_SCOPES as readonly string[]).includes(rawScope) ? rawScope : 'internal'
    return { ...o, scope }
  }
  return val
}, z.object({
  name: z.string(),
  type: z.string(),
  scope: z.enum(VALID_SCOPES),
  technology: z.string().optional(),
  relationship: z.enum(['system', 'dependency', 'investigated', 'adjacent', 'proposed', 'historical']).default('system'),
  scopeEvidence: z.string().optional(),
}))

const DataFlowSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const o = val as Record<string, unknown>
    return {
      from: o.from ?? o.source ?? o.src ?? o.origin,
      to: o.to ?? o.destination ?? o.dest ?? o.target,
      data: o.data ?? o.dataType ?? o.type ?? '',
      protocol: o.protocol,
    }
  }
  return val
}, z.object({
  from: z.string(),
  to: z.string(),
  data: z.string(),
  protocol: z.string().optional(),
}))

const DEFAULT_TECH_FLAGS = {
  hasAI: false, hasMicroservices: false, hasKubernetes: false,
  hasAuthSystem: false, hasExternalIntegrations: false,
  hasDatabaseLayer: false, hasFileStorage: false, hasMessageQueue: false,
}

// All fields are optional with defaults so partial model output (individual components,
// missing sections, etc.) still produces a usable ArchitectureData rather than a hard fail.
const ArchitectureOutputSchema = z.object({
  systemDescription: z.string().default(''),
  components: z.array(ComponentSchema).default([]),
  dataFlows: z.array(DataFlowSchema).default([]),
  trustBoundaries: z.array(z.string()).default([]),
  externalEntities: z.array(z.string()).default([]),
  dataStores: z.array(z.string()).default([]),
  apiEndpoints: z.array(z.string()).default([]),
  deploymentInfo: z.string().default(''),
  mermaidDfd: z.string().default(''),
  mermaidArchitectureDiagram: z.string().optional(),
  techFlags: TechFlagsSchema.default(DEFAULT_TECH_FLAGS),
  detailedTopology: DetailedTopologySchema.optional(),
})

export const SYSTEM_PROMPT = `You are an expert software architect specialized in security architecture analysis.
Your task is to analyze the provided system description and extract a structured architecture model.

IMPORTANT: Your role here is ARCHITECTURE UNDERSTANDING, not security analysis. Reconcile cross-document references, contradictions and environmental qualifications against the original SRC sections; do not resolve conflicting claims by silently selecting one.
Do NOT identify threats or vulnerabilities at this stage.
Do NOT produce diagrams: every diagram is rendered deterministically from the
structured components and data flows you return. Spend your effort on getting
those right.

SCOPE RULES:
- Model only the target system and dependencies with explicitly described integration edges.
- Classify each component's relationship as system, dependency, investigated, adjacent, proposed, or historical, and include a short source excerpt in scopeEvidence.
- Services mentioned only as subjects of incident investigations are investigated systems, not deployed parts of the investigation tool.
- Adjacent tools and proposed future integrations are not current dependencies. Preserve their classification; never invent an integration edge.
- Do not infer administrator privileges from authorship, ownership, or participation. Use unknown unless privilege is stated.
- Collapse aliases only when the source explicitly identifies them as the same entity. An LLM provider is not the host or dispatcher merely because their names overlap.
- "Unverified" documentation is not an access-control setting. A citation URL is not evidence that application transport uses TLS.

Extract and structure:
1. All system components (name, type: frontend/backend/database/queue/cache/gateway/etc, scope, technology stack)
2. Data flows between components (source, destination, data type, protocol)
3. Trust boundaries (network zones, authentication boundaries)
4. External entities (third-party services, APIs, users)
5. Data stores (databases, file systems, caches)
6. API endpoints (REST, GraphQL, WebSocket, gRPC)
7. Deployment information (cloud provider, containerization, orchestration)
8. Technology flags for pipeline routing

TECH FLAG DETECTION:
- hasAI: true if system uses ML models, LLMs, embeddings, recommendation engines, or AI inference
- hasMicroservices: true if system has 3+ independent services, service mesh, or microservice patterns
- hasKubernetes: true if mentions k8s, kubernetes, helm, pods, deployments, services, ingress
- hasAuthSystem: true if has OAuth, JWT, SSO, SAML, or dedicated auth service
- hasExternalIntegrations: true if connects to external APIs (Stripe, Twilio, Jira, Salesforce, etc.)
- hasDatabaseLayer: true if has any database (SQL, NoSQL, cache)
- hasFileStorage: true if has S3, GCS, Azure Blob, local filesystem, CDN
- hasMessageQueue: true if has Kafka, RabbitMQ, SQS, Redis Streams, or event bus

ENHANCED TOPOLOGY EXTRACTION (if mentioned in input):

ACTORS AND ROLES:
Extract human or system actors interacting with the system:
- name: Actor name (e.g., "End User", "Administrator", "Service Account")
- description: Brief description of what this actor does
- privilegeLevel: "admin" | "user" | "public" | "service" | "system"
- reference: Where in input this is mentioned (e.g., "Section 3.1", "Page 5")

ENVIRONMENT VARIABLES:
Extract configuration variables that affect security:
- name: Variable name (DATABASE_URL, JWT_SECRET, API_KEY, etc.)
- value: "[REDACTED]" if it contains credentials/secrets, or actual value if safe
- isSensitive: true if contains passwords, keys, tokens, URLs with credentials
- component: Which component uses this variable (e.g., "Backend API", "Kong Gateway")

SECURITY CONFIGURATIONS:
Document security controls explicitly mentioned or notably absent:
- component: Component name (e.g., "Kong Gateway v3.2", "WAF", "Firewall")
- configType: "plugin" | "firewall" | "iam" | "policy" | "rule" | "setting"
- isEnabled: true if enabled/configured, false if explicitly disabled or missing
- details: Specific config (e.g., "jwt validation disabled", "rate-limiting: 100 req/min", "CORS: allow all origins")

Example detailedTopology:
{
  "actors": [
    {"name": "End User", "description": "Customers registering accounts", "privilegeLevel": "user", "reference": "Section 2.1"},
    {"name": "Admin", "description": "System administrators", "privilegeLevel": "admin", "reference": "Section 4"}
  ],
  "environmentVars": [
    {"name": "DATABASE_URL", "value": "[REDACTED]", "isSensitive": true, "component": "Backend API"},
    {"name": "LOG_LEVEL", "value": "debug", "isSensitive": false, "component": "Backend API"}
  ],
  "securityConfigs": [
    {"component": "Kong Gateway", "configType": "plugin", "isEnabled": false, "details": "jwt validation disabled"},
    {"component": "Kong Gateway", "configType": "plugin", "isEnabled": false, "details": "rate-limiting not configured"}
  ]
}

OUTPUT FORMAT: Return ONLY a valid JSON object with EXACTLY these field names (camelCase, no variations):

{
  "systemDescription": "one paragraph describing the system",
  "components": [
    { "name": "ComponentName", "type": "backend|frontend|database|cache|queue|gateway|service|external", "scope": "internal|dmz|public|cloud|external", "technology": "optional tech stack" }
  ],
  "dataFlows": [
    { "from": "SourceComponent", "to": "DestinationComponent", "data": "what data flows", "protocol": "HTTP|HTTPS|gRPC|etc" }
  ],
  "trustBoundaries": ["boundary name as plain string", "another boundary"],
  "externalEntities": ["entity name as plain string", "another entity"],
  "dataStores": ["store name as plain string", "another store"],
  "apiEndpoints": ["endpoint as plain string", "another endpoint"],
  "deploymentInfo": "single string describing deployment",
  "techFlags": {
    "hasAI": false, "hasMicroservices": false, "hasKubernetes": false,
    "hasAuthSystem": false, "hasExternalIntegrations": false,
    "hasDatabaseLayer": false, "hasFileStorage": false, "hasMessageQueue": false
  },
  "detailedTopology": {
    "actors": [{ "name": "Actor", "description": "...", "privilegeLevel": "user", "reference": "..." }],
    "environmentVars": [{ "name": "VAR_NAME", "value": "[REDACTED]", "isSensitive": true, "component": "..." }],
    "securityConfigs": [{ "component": "...", "configType": "plugin", "isEnabled": false, "details": "..." }]
  }
}

IMPORTANT: trustBoundaries, externalEntities, dataStores, and apiEndpoints must be arrays of plain strings, NOT arrays of objects.

CRITICAL: Your ENTIRE response must be the JSON object above. Do NOT write any explanation, analysis, preamble, or text before or after the JSON. Start your response with { and end with }.`

/**
 * Per-section extraction prompt. Deliberately narrower than the full prompt:
 * one section cannot describe the whole system, so asking for a system-wide
 * summary per chunk invites invention.
 */
const SECTION_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

SECTION MODE: the text below is ONE SECTION of a larger document.
- Extract only what this section actually states. Do not infer the rest of the system.
- systemDescription: one sentence about what THIS section covers, or "" if unclear.
- Omit a field entirely rather than guessing a value for it.`

/** Fill the diagram fields from the structured model instead of the prompt. */
function withDeterministicDiagram(architecture: ArchitectureData): ArchitectureData {
  const diagram = buildArchitectureMermaid(architecture)
  return { ...architecture, mermaidDfd: diagram, mermaidArchitectureDiagram: diagram }
}

async function parseSingle(
  llm: BaseChatModel,
  systemPrompt: string,
  task: string,
  untrusted: string,
  signal: AbortSignal | undefined,
  maxRetries: number,
): Promise<ArchitectureData> {
  return invokeWithRetry({
    llm,
    systemPrompt,
    task,
    untrusted,
    outputSchema: ArchitectureOutputSchema,
    agentName: 'ArchitectureParser',
    maxRetries,
    signal,
  })
}

export async function runArchitectureParser(
  llm: BaseChatModel,
  rawInput: string,
  signal?: AbortSignal | undefined
): Promise<ArchitectureData> {
  const sourceEvidence = createSourceEvidence(rawInput)
  const packets = packSourceSections(sourceEvidence.sections, sourceCharacterBudget(llm, 10_000))
  const chunks = packets.map((sections, index) => ({ index, heading: sections[0]?.heading ?? '', text: formatSourceSections(sections) }))
  sourceEvidence.extraction.mode = chunks.length <= 1 ? 'full' : 'sectioned'
  sourceEvidence.extraction.attempted = sourceEvidence.sections.map(s => s.id)

  if (chunks.length === 1) {
    const result = await parseSingle(
      llm,
      SYSTEM_PROMPT,
      'Extract the architecture model of the system described below.',
      chunks[0]!.text,
      signal,
      3,
    )
    return { ...withDeterministicDiagram(redactArchitectureSecrets(result)), sourceEvidence }
  }

  // Map: keep local inference sequential, but let hosted providers process a
  // small bounded batch. Applying the local-only constraint to Kimi turned a
  // 178 KB document into fifteen serial reasoning calls inside one phase.
  const provider = providerNameOf(llm)
  const configuredConcurrency = Number(process.env.ARCHITECTURE_CHUNK_CONCURRENCY)
  const concurrency = resolveArchitectureChunkConcurrency(
    provider,
    chunks.length,
    Number.isFinite(configuredConcurrency) ? configuredConcurrency : undefined,
  )
  // A remote timeout should degrade one section, not immediately spend another
  // five minutes and hold the entire architecture phase open. Local inference
  // keeps its retry because transient model startup failures are recoverable.
  const sectionMaxRetries = provider === 'ollama' ? 2 : 1
  agentLog(
    `[ArchitectureParser] input is ${rawInput.length} chars — extracting ${chunks.length} sections ` +
      `(concurrency ${concurrency})`,
  )
  const results = await mapWithConcurrency(chunks, concurrency, async (chunk) => {
    const startedAt = Date.now()
    try {
      const part = await parseSingle(
        llm,
        SECTION_SYSTEM_PROMPT,
        `Extract the architecture facts stated in section ${chunk.index + 1} of ${chunks.length}` +
          `${chunk.heading ? ` ("${chunk.heading}")` : ''}.`,
        `Target context (use only to resolve which system is being described):\n${rawInput.slice(0, 2000)}\n\nSection evidence:\n${chunk.text}`,
        signal,
        sectionMaxRetries,
      )
      agentLog(
        `[ArchitectureParser] section ${chunk.index + 1}/${chunks.length} parsed in ` +
          `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      )
      return { part: part as PartialArchitecture, failure: null }
    } catch (error) {
      if (isProviderBillingError(error) || (error instanceof Error && error.name === 'AbortError')) throw error
      // One unreadable section must not lose the other twenty.
      agentLog(
        `[ArchitectureParser] section ${chunk.index + 1}/${chunks.length} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      return { part: null, failure: chunk.index + 1 }
    }
  })
  const parts = results
    .map((result) => result.part)
    .filter((part): part is PartialArchitecture => part !== null)
  const failures = results
    .map((result) => result.failure)
    .filter((failure): failure is number => failure !== null)

  if (parts.length === 0) {
    throw new Error(
      `ArchitectureParser: every one of the ${chunks.length} input sections failed to parse`,
    )
  }

  // Reduce: deterministic union, then one small pass for the system-wide prose
  // that no single section can produce on its own.
  const merged = mergePartialArchitectures(parts)
  const inventory = [
    `Components: ${(merged.components ?? []).map((c) => c.name).join(', ') || '(none)'}`,
    `Data stores: ${(merged.dataStores ?? []).join(', ') || '(none)'}`,
    `External entities: ${(merged.externalEntities ?? []).join(', ') || '(none)'}`,
    `Trust boundaries: ${(merged.trustBoundaries ?? []).join(', ') || '(none)'}`,
    `Deployment notes: ${merged.deploymentInfo || '(none)'}`,
  ].join('\n')

  let overview: ArchitectureData | undefined
  try {
    overview = await parseSingle(
      llm,
      SYSTEM_PROMPT,
      'Write the system-wide description and deployment summary for the inventory below. ' +
        'Return the same JSON shape; components, dataFlows and lists may be returned empty — ' +
        'they are already extracted.',
      inventory,
      signal,
      2,
    )
  } catch (error) {
    if (isProviderBillingError(error) || (error instanceof Error && error.name === 'AbortError')) throw error
    agentLog('[ArchitectureParser] overview pass failed; using concatenated section summaries')
  }

  const assembled = ArchitectureOutputSchema.parse({
    ...merged,
    systemDescription: overview?.systemDescription?.trim() || merged.systemDescription || '',
    deploymentInfo: overview?.deploymentInfo?.trim() || merged.deploymentInfo || '',
  })

  sourceEvidence.extraction.failed = failures.flatMap(index => packets[index - 1]!.map(s => s.id))
  const withFailureNote = failures.length
    ? {
        ...assembled,
        systemDescription:
          `${assembled.systemDescription}\n\n[Partial extraction: ${failures.length} of ` +
          `${chunks.length} input sections could not be parsed (sections ${failures.join(', ')}).]`.trim(),
      }
    : assembled

  return { ...withDeterministicDiagram(redactArchitectureSecrets(withFailureNote)), sourceEvidence }
}
