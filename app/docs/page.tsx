import type { ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { PUBLIC_API_ENDPOINTS } from '@/lib/api/contracts'
import { ANALYSIS_STATUSES } from '@/lib/db/enums'
import { DEFAULT_PROVIDER_MODELS, LLM_PROVIDERS, PROVIDER_METADATA } from '@/lib/llm/providers'
import styles from './docs-v2.module.css'

const SECTIONS = [
  ['overview', 'Overview'],
  ['current-state', 'Current state'],
  ['quick-start', 'Quick start'],
  ['dependencies', 'Dependencies'],
  ['models', 'Model guide'],
  ['provider-routing', 'Provider routing'],
  ['rag', 'Knowledge base and RAG'],
  ['review-memory', 'Review memory'],
  ['workflow', 'Analysis workflow'],
  ['context-coverage', 'Context and coverage'],
  ['finding-quality', 'Finding quality and scores'],
  ['identifiers', 'Threat identifiers'],
  ['api', 'API reference'],
  ['troubleshooting', 'Troubleshooting'],
] as const

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className={styles.section + ' scroll-mt-24 space-y-5'}>
      <div className={styles.sectionTitle}>
        <span>{eyebrow.split(' / ')[0]}</span>
        <h2 className="text-2xl font-semibold tracking-tight text-[#111111]">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <pre className={styles.codeBlock}>
      <code>{String(children).trim()}</code>
    </pre>
  )
}

function Endpoint({ method, path, purpose }: { method: string; path: string; purpose: string }) {
  const color = method === 'GET' ? 'text-[#333333] bg-[#f1f1f0] border-[#cacac7]' : method === 'PATCH' ? 'text-amber-900 bg-amber-50 border-amber-200' : 'text-blue-800 bg-blue-50 border-blue-200'
  return (
    <tr className="border-b border-slate-100 last:border-b-0">
      <td className="px-3 py-3"><span className={`inline-flex w-14 justify-center border px-1.5 py-0.5 font-mono text-[10px] font-bold ${color}`}>{method}</span></td>
      <td className="px-3 py-3 font-mono text-xs text-[#111111]">{path}</td>
      <td className="px-3 py-3 text-sm text-slate-600">{purpose}</td>
    </tr>
  )
}

function ProviderRouteCard({
  name,
  optimized,
  fullPower,
  note,
}: {
  name: string
  optimized: [string, string]
  fullPower: string
  note: string
}) {
  const phases = [
    ['Parse', optimized[0]],
    ['Analyze', optimized[1]],
    ['Debate', optimized[1]],
    ['Synthesize', optimized[1]],
    ['Validate', optimized[0]],
  ]
  return (
    <div className={styles.providerCard}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[#111111]">{name}</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">{note}</p>
        </div>
        <span className="border border-[#e4e4e2] bg-[#f5f7f5] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#666666]">Single vendor</span>
      </div>
      <div className="mt-4 overflow-x-auto">
        <div className="flex min-w-[620px] items-stretch gap-2">
          {phases.map(([phase, model], index) => (
            <div key={phase} className="contents">
              <div className="min-w-0 flex-1 border border-[#e4e4e2] bg-[#fcfcfb] p-3">
                <span className="block text-[9px] font-bold uppercase tracking-wider text-[#666666]">{phase}</span>
                <span className="mt-2 block font-mono text-[10px] leading-4 text-[#31483f]">{model}</span>
              </div>
              {index < phases.length - 1 ? <span className="self-center text-[#111111]">→</span> : null}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 border border-[#cacac7] bg-[#f1f1f0] px-3 py-2 text-[11px] leading-5 text-[#444444]">
        <strong>Full Power:</strong> every LLM phase uses <code className="font-mono">{fullPower}</code>.
      </div>
    </div>
  )
}

export default function DocsPage() {
  return (
    <div className={styles.layout}>
      <aside className={styles.aside}>
        <div className="sticky top-24 space-y-5">
          <nav aria-label="Documentation sections" className={styles.toc}>
            <p className={styles.tocLabel}>Explore the guide</p>
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`}>
                {label}
              </a>
            ))}
          </nav>
          <div className={styles.apiCard}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Local API</p>
            <code className="mt-1 block text-xs leading-5 text-[#111111]">localhost:3000<br />/api/v1</code>
          </div>
        </div>
      </aside>

      <article className={styles.article}>
        <details className={styles.mobileToc}><summary>Jump to a section <span aria-hidden="true">↓</span></summary><nav aria-label="Documentation sections">{SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav></details>
        <header id="overview" className={styles.hero}>
          <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-slate-500">
            <Image src="/brand/argus-wordmark.svg" width={440} height={100} alt="Argus" className="h-auto w-[148px]" />
            <span className="border border-[#cacac7] bg-[#f1f1f0] px-2 py-1 text-[#333333]">Local-first</span>
            <span>Documentation</span>
          </div>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.035em] text-[#111111] sm:text-5xl">Build and review threat models on your own machine.</h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-slate-600">
            Argus turns architecture descriptions and supporting documents into reviewable STRIDE, PASTA and Attack Tree findings. The browser UI, pipeline, models, vector search and workspace database can all run locally. The API is available for automation, but it is not required to use the product.
          </p>
          <div className={styles.journey}>
            {[
              ['1', 'Describe', 'Paste a system description or upload documents.'],
              ['2', 'Analyze', 'Specialized agents inspect architecture and abuse paths.'],
              ['3', 'Debate', 'Red and blue perspectives challenge weak findings.'],
              ['4', 'Review', 'Triage, comment and export the final model.'],
            ].map(([number, title, copy]) => (
              <div key={number} className={styles.journeyStep}>
                <span className="font-mono text-xs font-bold text-[#111111]">0{number}</span>
                <h2 className="mt-2 text-sm font-semibold text-[#111111]">{title}</h2>
                <p className="mt-1 text-xs leading-5 text-slate-600">{copy}</p>
              </div>
            ))}
          </div>
        </header>

        <Section id="current-state" eyebrow="01 / Product" title="What is available now">
          <p className="text-sm leading-6 text-slate-600">
            Argus is currently a PhiloCyber-branded, local-first security workspace. The primary path is a single-user browser application backed by one portable SQLite workspace per project. PostgreSQL remains available for shared service deployments, but is not required for the local product.
          </p>
          <div className="grid gap-px border border-slate-200 bg-slate-200 sm:grid-cols-2">
            {[
              ['Local project workspaces', 'Create or select a project in the UI. Analyses, review decisions, uploads and run artifacts stay isolated in that project.'],
              ['Independent pipeline worker', 'POST /analyze enqueues pending. pipeline-worker claims the run with a renewable lease. Restarting the UI does not abort analysis. Stop marks the row failed and persists cancellation for the worker.'],
              ['Complete analysis pipeline', 'STRIDE, PASTA and Attack Trees feed Red/Blue debate, synthesis, DREAD validation, progress streaming and durable cancellation.'],
              ['Knowledge operations', 'Upload approved technical or corporate sources, inspect the local inventory and run a real Chroma synchronization with live logs.'],
              ['Safe reindexing', 'Verified generations publish together after source and chunk checks. Retries reuse completed batches of the same corpus version.'],
              ['Draft recovery', 'An unfinished Run Analysis form survives navigation and full reloads in the same browser tab, then clears only after the API accepts the run.'],
              ['Provider boundary', 'Ollama, Gemini, Kimi, Bedrock and Cursor are supported. Every phase and retry stays with the provider authorized for that run.'],
            ].map(([title, copy]) => (
              <div key={title} className="bg-white p-4">
                <h3 className="text-sm font-semibold text-[#111111]">{title}</h3>
                <p className="mt-2 text-xs leading-5 text-slate-600">{copy}</p>
              </div>
            ))}
          </div>
          <div className="border border-[#cacac7] bg-[#f1f1f0] px-4 py-3 text-sm leading-6 text-[#555555]">
            <strong className="text-[#111111]">Deployment boundary:</strong> the local UI has no browser login and should remain bound to localhost. Shared deployment requires a separate security and infrastructure review. This delivery supports a single-user local PoC.
          </div>
        </Section>

        <Section id="quick-start" eyebrow="02 / Setup" title="Quick start">
          <p className="text-sm leading-6 text-slate-600">The recommended setup needs only Docker Desktop. The platform launcher checks the host, prepares a private configuration, downloads the selected Ollama models and starts Argus, pipeline-worker and Chroma. PostgreSQL and cloud providers are optional.</p>
          <ol className="space-y-5">
            {[
              ['Install and start on Windows', 'Use setup.cmd from Command Prompt or setup.ps1 from PowerShell. If Docker Desktop is absent, the launcher asks before using winget.', '# Command Prompt\nscripts\\setup.cmd\n\n# PowerShell\n.\\scripts\\setup.ps1'],
              ['Install and start on macOS', 'Run from Terminal. If Docker Desktop is absent, the launcher can install it through Homebrew after confirmation.', 'bash scripts/setup.sh'],
              ['Use a smaller profile', 'For constrained machines, reuse the 4B model for both analysis tiers and use the 0.6B embedding model. This lowers resource use and quality.', '# macOS\nbash scripts/setup.sh --light\n\n# Windows PowerShell\n.\\scripts\\setup.ps1 -Light'],
              ['Operate the stack', 'Status, logs and stop are explicit actions. Stop preserves every named volume.', '# Replace ACTION with status, logs, or stop\n.\\scripts\\setup.ps1 ACTION\nbash scripts/setup.sh ACTION'],
            ].map(([title, copy, code], index) => (
              <li key={title} className="grid gap-3 sm:grid-cols-[42px_minmax(0,1fr)]">
                <div className="grid h-9 w-9 place-items-center border border-[#111111] font-mono text-xs font-bold text-[#111111]">{String(index + 1).padStart(2, '0')}</div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-[#111111]">{title}</h3>
                  <p className="mt-1 text-sm text-slate-600">{copy}</p>
                  <div className="mt-2"><CodeBlock>{code}</CodeBlock></div>
                </div>
              </li>
            ))}
          </ol>
          <div className="border border-[#cacac7] bg-[#f1f1f0] px-4 py-3 text-sm text-[#333333]">
            Argus opens at <code className="font-mono">http://127.0.0.1:8080</code>. Verify the full stack at <code className="font-mono">/api/v1/health</code>. In local mode, the database should report <code>up</code>. RAG is ready only when <code>rag.usable</code> is true — a Chroma heartbeat alone is not enough. Health also reports pipeline-worker liveness; a <code>pending</code> analysis with worker <code>down</code> means nothing will claim the row.
          </div>
        </Section>

        <Section id="dependencies" eyebrow="03 / Runtime" title="What each dependency does">
          <div className="overflow-x-auto border border-slate-200 bg-white">
            <table className="w-full text-left">
              <thead className="bg-[#fcfcfb] text-[11px] uppercase tracking-wider text-slate-500"><tr><th className="px-4 py-3">Dependency</th><th className="px-4 py-3">Required</th><th className="px-4 py-3">Role</th></tr></thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {[
                  ['Docker Desktop', 'Recommended path', 'The only host dependency. Runs the complete local stack with persistent volumes.'],
                  ['Node.js 22.23.2', 'Native development', 'Runs Next.js, the UI, API and pipeline-worker outside Docker. Minimum supported version: 22.13.'],
                  ['pnpm 11.1.2', 'Native development', 'Installs dependencies and runs project scripts outside Docker.'],
                  ['Ollama', 'Included', 'Serves the quick, deep and embedding models inside the private Compose network.'],
                  ['Chroma', 'Included', 'Vector database used by RAG to retrieve relevant security knowledge.'],
                  ['SQLite', 'Built in', 'Persists each local project and its analysis history without a separate server.'],
                  ['PostgreSQL', 'Optional', 'Shared database mode for a hosted or multi-user deployment.'],
                ].map(([name, required, role]) => <tr key={name}><td className="px-4 py-3 font-semibold text-[#111111]">{name}</td><td className="px-4 py-3 text-slate-600">{required}</td><td className="px-4 py-3 text-slate-600">{role}</td></tr>)}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="models" eyebrow="04 / Inference" title="Choose a model profile">
          <p className="text-sm leading-6 text-slate-600">Argus separates quick parsing and validation from deeper threat synthesis. Choose the profile that fits in memory reliably. A smaller stable model is better than a larger model that constantly swaps between RAM and VRAM.</p>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              ['Lean / CPU', '16 GB system RAM', 'qwen3.5:4b', 'qwen3.5:4b', '8K / 8K', 'Lowest memory use. Good for UI and pipeline tests.'],
              ['Recommended', '8 GB VRAM · 32 GB RAM', 'qwen3.5:4b', 'qwen3.5:9b', '16K / 16K', 'Balanced local starting point; verify evidence coverage.'],
              ['High memory', '20 GB+ free model memory', 'qwen3.5:9b', 'qwen3.5:27b', '16K / 32K', 'Higher synthesis quality with slower generation.'],
            ].map(([name, hardware, quick, deep, context, note], index) => (
              <div key={name} className={`border p-5 ${index === 1 ? 'border-[#111111] bg-orange-50/40' : 'border-slate-200 bg-white'}`}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-[#111111]">{name}</p>
                <p className="mt-2 text-xs text-slate-500">{hardware}</p>
                <dl className="mt-4 space-y-2 text-xs"><div className="flex justify-between gap-2"><dt className="text-slate-500">Quick</dt><dd className="font-mono font-semibold text-[#111111]">{quick}</dd></div><div className="flex justify-between gap-2"><dt className="text-slate-500">Deep</dt><dd className="font-mono font-semibold text-[#111111]">{deep}</dd></div><div className="flex justify-between gap-2"><dt className="text-slate-500">Context</dt><dd className="font-mono font-semibold text-[#111111]">{context}</dd></div></dl>
                <p className="mt-4 text-xs leading-5 text-slate-600">{note}</p>
              </div>
            ))}
          </div>
          <p className="text-sm leading-6 text-slate-600">These are manual sizing examples, not automatic context presets. The example below sets both tiers to 16K; the application default for the deep tier is 32K. Reducing context may reduce retained evidence.</p>
          <CodeBlock>{`LLM_PROVIDER="ollama"
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_QUICK_MODEL="qwen3.5:4b"
OLLAMA_DEEP_MODEL="qwen3.5:9b"
OLLAMA_QUICK_NUM_CTX="16384"
OLLAMA_DEEP_NUM_CTX="16384"`}</CodeBlock>
          <p className="text-xs leading-5 text-slate-500">Model package sizes currently published by Ollama are 3.4 GB for Qwen 3.5 4B, 6.6 GB for 9B and 17 GB for 27B. Runtime memory is higher and varies with context length. See the <a className="font-semibold text-[#111111] underline" href="https://ollama.com/library/qwen3.5">official Qwen 3.5 model library</a>.</p>
        </Section>

        <Section id="provider-routing" eyebrow="05 / Routing" title="Choose who may process the analysis">
          <p className="text-sm leading-6 text-slate-600">
            Provider selection is an authorization boundary. Each run uses exactly one provider and one compatible execution profile. Every phase, retry, architecture detail, RAG passage and threat candidate stays inside that selected provider boundary.
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {LLM_PROVIDERS.map((provider) => (
              <div key={provider} className="border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600">
                <strong className="text-[#111111]">{PROVIDER_METADATA[provider].label}</strong>
                <span className="block">{PROVIDER_METADATA[provider].privacy}</span>
                <code className="font-mono">{DEFAULT_PROVIDER_MODELS[provider].quick} / {DEFAULT_PROVIDER_MODELS[provider].deep}</code>
              </div>
            ))}
          </div>

          <div className="border border-[#d9b89f] bg-[#f1f1f0] p-4 text-sm leading-6 text-[#70422f]">
            <strong className="text-[#542e20]">Cloud data policy:</strong> use cloud inference for sensitive or critical systems only after confirming a Zero Data Retention (ZDR) agreement, residency and logging terms. For testing and non-sensitive systems, Kimi is the recommended cost-to-quality starting point. Use Ollama when context must remain local.
          </div>

          <div className="border border-[#cacac7] bg-white p-4 text-sm leading-6 text-slate-600">
            <strong className="text-[#111111]">Credentials from the UI:</strong> open <strong>Run Analysis → Advanced configuration → Provider credentials</strong> to validate and save, replace or remove Gemini, Kimi, Bedrock or Cursor credentials. Locally managed secrets are written only to the Git-ignored <code className="font-mono text-xs">.env.local</code> file with restricted permissions and are never returned to the browser.
          </div>

          <div id="quality-gate-boundary" className="scroll-mt-24 border border-[#cacac7] bg-[#f1f1f0] p-4">
            <h3 className="text-sm font-semibold text-[#111111]">Local-only is enforced, not advisory</h3>
            <p className="mt-2 text-sm leading-6 text-[#333333]">
              When the boundary contains only Ollama, every phase, retry and escalation remains on Ollama. If a model is missing, times out or fails a quality check, the run fails or retries locally. Argus does not silently fall back to Kimi, Gemini or Bedrock.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {[
              ['Local Efficient', 'Ollama only', 'Quick and deep local tiers. Cloud vendors are removed from the boundary.'],
              ['Provider Optimized', 'One primary vendor', 'Quick tier for mechanical work and deep tier for reasoning-heavy phases.'],
              ['Provider Full Power', 'One primary vendor', 'The configured deep tier runs every LLM phase.'],
              ['Adaptive Value', 'Selected provider only', 'Starts optimized and reserves a same-provider retry path. Automatic rerouting is not enabled yet.'],
            ].map(([title, scope, copy]) => (
              <div key={title} className="border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-[#111111]">{title}</h3><span className="text-[10px] font-bold uppercase tracking-wider text-[#111111]">{scope}</span></div>
                <p className="mt-2 text-xs leading-5 text-slate-600">{copy}</p>
              </div>
            ))}
          </div>

          <h3 className="text-sm font-semibold text-[#111111]">Ollama route</h3>
          <ProviderRouteCard
            name="Ollama · Local Efficient"
            optimized={['qwen3.5:4b', 'qwen3.5:9b']}
            fullPower="the configured local deep model"
            note="Best for private, offline-capable analysis. Concurrency and context stay bounded for laptop hardware."
          />

          <h3 className="text-sm font-semibold text-[#111111]">Kimi route</h3>
          <ProviderRouteCard
            name="Kimi / Moonshot · Provider Optimized"
            optimized={['kimi-k2.6', 'kimi-k3']}
            fullPower="kimi-k3"
            note="K2.6 handles efficient stages; K3 handles STRIDE, debate and synthesis. Select the Global or China API region that issued the key. Readiness checks authenticate through the model catalog before testing inference."
          />

          <h3 className="text-sm font-semibold text-[#111111]">Gemini route</h3>
          <ProviderRouteCard
            name="Google Gemini · Provider Optimized"
            optimized={['GEMINI_QUICK_MODEL', 'GEMINI_DEEP_MODEL']}
            fullPower="GEMINI_DEEP_MODEL"
            note="Keep stable, lower-cost models in the quick tier and configure the strongest accepted model in the deep tier. Preview models should be pinned intentionally."
          />

          <h3 className="text-sm font-semibold text-[#111111]">Claude through Bedrock route</h3>
          <ProviderRouteCard
            name="AWS Bedrock · Provider Optimized"
            optimized={['BEDROCK_QUICK_MODEL', 'BEDROCK_DEEP_MODEL']}
            fullPower="BEDROCK_DEEP_MODEL"
            note="A typical route uses Haiku for quick stages and Sonnet or Opus for deep stages, subject to model access in the selected AWS region."
          />

          <h3 className="text-sm font-semibold text-[#111111]">Cursor route</h3>
          <ProviderRouteCard
            name="Cursor · Grok 4.7"
            optimized={['grok-4.7 · Fast when enabled', 'grok-4.7']}
            fullPower="the configured Cursor deep model"
            note="Both tiers default to Grok 4.7 through the Cursor SDK. The quick tier uses Fast when the account supports it and CURSOR_QUICK_FAST is enabled. Existing model overrides stay explicit."
          />

          <div className="border border-[#cacac7] bg-[#fcfcfb] p-4 text-xs leading-5 text-[#555555]">
            <strong className="text-[#111111]">Important:</strong> Full Power means the strongest model configured for that vendor, not an automatic cross-vendor upgrade. If Kimi is primary, every phase remains Kimi. If Ollama is the only allowed vendor, Full Power means the local deep model in every phase.
          </div>

          <CodeBlock>{`config = @{
  provider = "ollama"
  allowedProviders = @("ollama")
  executionProfile = "local_efficient"
  allowedProfiles = @("local_efficient")
}`}</CodeBlock>
        </Section>

        <Section id="rag" eyebrow="06 / Knowledge" title="Knowledge base and RAG">
          <p className="text-xs font-medium text-slate-500">Citations keep unverified excerpts; matching is literal. Index recovery and PDF migration follow the workflows below.</p>
          <p className="text-sm leading-6 text-slate-600">Argus retrieves technical references, organizational context and prior decisions for the same system to support threat analysis. Chroma stores technical and corporate vectors; threat models and human review decisions remain in SQLite or PostgreSQL. Retrieved context can inform a finding, but does not by itself establish that the system is vulnerable or that a control is implemented.</p>
          <nav aria-label="Knowledge documentation topics" className="flex flex-wrap gap-x-5 gap-y-2 text-xs font-semibold text-[#111111]">
            <a href="#knowledge-sources" className="underline underline-offset-4">Choose sources</a>
            <a href="#knowledge-indexing" className="underline underline-offset-4">Upload and index</a>
            <a href="#knowledge-index-reuse" className="underline underline-offset-4">Incremental retries</a>
            <a href="#knowledge-pdf-migration" className="underline underline-offset-4">PDF migration</a>
            <a href="#knowledge-retrieval" className="underline underline-offset-4">Current retrieval</a>
            <a href="#knowledge-roadmap" className="underline underline-offset-4">Implemented improvements</a>
          </nav>
          <div className="flex flex-wrap items-center justify-between gap-4 border border-[#d9b7a7] bg-[#f1f1f0] p-4 text-sm leading-6 text-[#5b463d]">
            <span><strong className="text-[#512f22]">Manage it from the UI.</strong> Choose a technical or corporate destination, upload approved documents, inspect the local inventory, and run the index job with live logs.</span>
            <Link href="/knowledge" className="shrink-0 border border-[#111111] bg-white px-3 py-2 text-xs font-bold text-[#111111] hover:bg-[#111111] hover:text-white">Open Knowledge Manager</Link>
          </div>

          <h3 id="knowledge-sources" className="scroll-mt-24 text-lg font-semibold text-[#111111]">Choose sources that answer different questions</h3>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              ['Technical references', 'Attack mechanisms, preconditions, platform guidance and mitigations. Store general material in technical/ and specialized material in research, ai_threats, books or risks_mitigations subfolders.'],
              ['Corporate context', 'Architecture, data classification, business dependencies, policies and sanitized incident lessons. Use corporate/. Clearly distinguish requirements and hypotheses from observed configurations, grants or tests.'],
              ['Reviewed decisions', 'Confirmed or rejected findings and their rationale can inform later scans of the same system after the entire source run is reviewed. They stay in the workspace database, outside global Chroma.'],
            ].map(([title, copy]) => <div key={title} className="border border-slate-200 bg-white p-4"><h4 className="text-sm font-semibold text-[#111111]">{title}</h4><p className="mt-2 text-xs leading-5 text-slate-600">{copy}</p></div>)}
          </div>
          <p className="text-sm leading-6 text-slate-600">Technical and corporate files are shared across this installation. Declared system/alias and environment metadata can filter incompatible sources; missing scope remains unknown. Keep the affected system, environment, effective date, original source and important qualifications next to each claim. A planned control does not mitigate current exposure; missing evidence does not prove that a control is absent.</p>

          <div id="review-memory" className="scroll-mt-24 rounded-[1.5rem] border border-[#d8ded8] bg-[#f3f7f2] p-5 sm:p-7">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#426354]">Review memory</p>
            <h3 className="mt-2 text-xl font-semibold tracking-tight text-[#17231c]">A completed review can help the next scan of this system.</h3>
            <p className="mt-3 text-sm leading-6 text-[#405148]">Confirm or reject every finding in a completed run and record the reviewer rationale. Later scans with the same system ID automatically receive a small selection of those decisions. There is no output picker and no copying between applications in the same project. Partial, failed, archived, incomplete, or partly reviewed runs do not contribute.</p>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {[
                ['01 · Current analysis', 'The new architecture, source quotations, controls and this run’s reasoning establish what is true now.'],
                ['02 · Retrieved knowledge', 'Relevant technical and corporate passages add context, with their own source and verification limits.'],
                ['03 · Prior decisions', 'Same-system reviewer decisions and rationale are historical hints. They never confirm, reject, suppress, score or prove a new finding automatically.'],
              ].map(([title, copy]) => <div key={title} className="rounded-2xl border border-[#d8ded8] bg-white/85 p-4"><h4 className="text-sm font-semibold text-[#17231c]">{title}</h4><p className="mt-2 text-xs leading-5 text-[#526159]">{copy}</p></div>)}
            </div>
            <p className="mt-4 text-xs leading-5 text-[#526159]">For facts shared across a project, such as the WAF configuration or API standards, maintain a reviewed corporate source with its scope and date. Review decisions from FinanceBot do not automatically apply to another PhiloBank application. This history is read from the workspace database even when RAG is off; changing a decision updates future scans without reindexing. It does not change existing results.</p>
          </div>

          <h3 id="knowledge-indexing" className="scroll-mt-24 text-lg font-semibold text-[#111111]">Upload, index and verify</h3>
          <ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-600">
            <li>Prepare complete, readable source text with section headings. Renaming an RTF file to Markdown does not convert its contents. Upload validation checks basic content and file constraints, not factual correctness or extraction quality.</li>
            <li>Choose the destination in Knowledge. Technical accepts Markdown, text, JSON, YAML, CSV and text-based PDF. Corporate accepts Markdown, text, JSON and YAML.</li>
            <li>Start Chroma and Ollama with the configured embedding model, then run the index action. It synchronizes the technical collections, document catalog and corporate collection. Review the job logs.</li>
            <li>Check readiness before starting the analysis. With Knowledge retrieval enabled, the start gate requires reachable Chroma, a non-empty vector collection and a successful embedding probe. A failed gate returns <code>409 RAG_UNAVAILABLE</code> without creating a run. Explicitly turn retrieval off to run without it.</li>
          </ol>
          <CodeBlock>{`EMBEDDING_PROVIDER="ollama"
EMBEDDING_MODEL="qwen3-embedding:4b"
CHROMA_HOST="localhost"
CHROMA_PORT="8000"
RAG_TOP_K="5"
KNOWLEDGE_BASE_PATH="./knowledge_base"
PAGE_INDICES_PATH="./data/page_indices"

# Add approved local documents; the repository does not ship a corpus
ollama pull qwen3-embedding:4b
# With Chroma and Ollama running, synchronize the local corpus
pnpm rag:index`}</CodeBlock>
          <div className="border border-[#cacac7] bg-[#fcfcfb] p-4 text-sm leading-6 text-[#555555]">
            <strong className="text-[#111111]">Uploaded does not always mean searchable.</strong> Uploads allow 20 files per request, 25 MiB per file and 100 MiB total. Indexing accepts files up to 25 MiB. The corporate loader has no 500-file cutoff. Unreadable, empty or oversized supported sources stop the rebuild instead of being silently omitted. Knowledge shows eligibility or the reason a file is skipped; Ready to index is not confirmation that extraction and indexing succeeded. Split larger corporate sources into coherent sections with their scope and qualifications intact. The inventory and index fingerprint do not certify full extraction or retrieval coverage.
          </div>
          <p className="text-sm leading-6 text-slate-600"><strong className="text-[#111111]">Index is up to date</strong> means the stored fingerprint matches source paths/content, embedding model, index format and chunking settings, and live vector checks pass. Changed sources or settings make reindexing available; redundant UI/API requests receive <code>409</code>. This status measures synchronization, not the relevance or accuracy of the knowledge.</p>
          <p className="text-sm leading-6 text-slate-600">Index format 6 keeps the configured embedding model unchanged and requires rebuilding older indexes. Chunk coverage checks verify the normalized document body. Fitting code blocks and tables stay together; larger blocks carry structure context separately from the exact quotation. Embedding inputs are sent without silent truncation. A context overflow stops indexing explicitly. These checks do not certify PDF extraction, OCR or retrieval relevance.</p>
          <p className="text-sm leading-6 text-slate-600">Embeddings run through Ollama. Selected passages are still sent to the LLM provider chosen for the scan, so local embeddings do not make a cloud-provider analysis local. Private corpus files are excluded from Git; keep them in approved storage.</p>

          <h3 id="knowledge-index-reuse" className="scroll-mt-24 text-lg font-semibold text-[#111111]">Retry indexing without embedding unchanged sources again</h3>
          <p className="text-sm leading-6 text-slate-600">Technical, catalog and corporate collections build separate generations. Completed batches are reused on retry when the corpus version, model, exact input and metadata still match. All seven collections are published together only after source inventory, stored chunks and counts are verified. A changed corpus may require embedding unchanged documents again. Older generations remain stored; automatic cleanup is not implemented.</p>
          <p className="text-sm leading-6 text-slate-600">Retry from Knowledge after fixing an error. A failed rebuild preserves the previous publication and completed staging batches. Keep knowledge files unchanged while indexing: a corpus change during the job prevents it from being marked successful. RAG remains unavailable during a running or failed rebuild. Wait for a successful job, an up-to-date index and Services ready before starting a RAG-enabled scan. The masthead polls health every 20 seconds.</p>
          <h3 id="knowledge-pdf-migration" className="scroll-mt-24 text-lg font-semibold text-[#111111]">Convert a PDF corpus to reviewed Markdown</h3>
          <p className="text-sm leading-6 text-slate-600">Use the repository workflow in <code>docs/operations/pdf-to-markdown.md</code>: convert one PDF to one Markdown file in a staging folder, validate page order and text coverage, review representative layouts and OCR, then promote the reviewed files and reindex. Original PDFs are archived outside the active corpus. The workflow also rebuilds page-index trees and verifies live RAG readiness. Text coverage does not prove that diagrams or tables retain every visual relationship.</p>
          <CodeBlock>{`# Install the PDF dependencies first, following the repository guide
.venv-pdf/bin/python scripts/pdf_to_markdown.py knowledge_base --output output/pdf-review/markdown
.venv-pdf/bin/python scripts/validate_pdf_markdown.py --corpus knowledge_base --converted output/pdf-review/markdown --ocr-sparse
# Review the output before confirming --reviewed; keep the local app running
.venv-pdf/bin/python scripts/promote_pdf_markdown.py --corpus knowledge_base --converted output/pdf-review/markdown --archive output/pdf-review/pdf-archive --reviewed --reindex`}</CodeBlock>
          <p className="text-sm leading-6 text-slate-600">If indexing fails after promotion, keep the archive and promoted Markdown and retry only the index action in Knowledge. Do not repeat promotion into the same destination. Verify known retrieval queries before a full scan; use a fresh run when the new corpus makes an old checkpoint incompatible.</p>

          <h3 id="knowledge-retrieval" className="scroll-mt-24 text-lg font-semibold text-[#111111]">How retrieval works today</h3>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="border border-slate-200 bg-white p-4"><h4 className="text-sm font-semibold text-[#111111]">Combined retrieval</h4><p className="mt-2 text-xs leading-5 text-slate-600">Catalog and direct technical search combine with vectors, document trees, section-level BM25 and authorized review history. The router filters incompatible declared scopes and unrelated passages, removes duplicates and applies source diversity and role budgets.</p></div>
            <div className="border border-slate-200 bg-white p-4"><h4 className="text-sm font-semibold text-[#111111]">Bounded follow-up</h4><p className="mt-2 text-xs leading-5 text-slate-600">Each step produces up to two query variants. One material unanswered question can trigger one additional lookup and a notes revision if new passages arrive. The run allows at most 40 router queries; unresolved gaps remain explicit.</p></div>
            <div className="border border-slate-200 bg-white p-4"><h4 className="text-sm font-semibold text-[#111111]">Evidence Inspector</h4><p className="mt-2 text-xs leading-5 text-slate-600">New traces show the exact delivered passages, versions, source metadata, query variants, rejection reasons, context usage and candidate preservation. Final traces persist in local artifacts or PostgreSQL result metadata.</p></div>
          </div>
          <details className="border border-slate-200 bg-white p-4">
            <summary className="cursor-pointer text-sm font-semibold text-[#111111]">What evidence verification establishes</summary>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-600">
              <li>Original passages reach structured generation alongside notes. Stable <code>RAG-…</code> references bind source version, chunk and exact passage. Invented or altered quotations are kept with <code>referenceStatus: unverified</code> (and <code>supportStatus: unlinked</code> when the excerpt does not name the component). They are not deleted. Matching is a contiguous excerpt plus component/title overlap, not semantic entailment.</li>
              <li>A verified reference means the source and quotation were checked. It does not prove that the quoted passage supports every part of the finding or that a control operates.</li>
              <li>New source-backed analyst responses must supply a matching original architecture quotation. Invalid quotations and duplicate candidates trigger bounded structured-response retries before that phase is accepted. RAG background alone cannot establish a system-specific finding.</li>
              <li>Candidate counts are upper bounds, not minimum quotas. Corrective retries receive the rejected response as untrusted data together with validation feedback. Fewer candidates are valid when the evidence cannot support more.</li>
              <li>Flat frontmatter carries system, aliases, environment, dates and assertion type. Incompatible declared scopes are filtered; absent metadata stays unknown. Dates filter retrieval when a cutoff is supplied.</li>
              <li>Corporate chunks are 1,800 characters and technical chunks are 1,200. Long legacy sections use a relevant window up to 2,400 characters. Rendered metadata and qualifications count against the role budget.</li>
              <li>Ranking currently requires lexical overlap after vector retrieval. Review synonyms, translations and missing source coverage. System filters select relevance and do not replace access controls.</li>
              <li>Only completed, fully reviewed runs of the same system contribute historical decisions. They can enter prompts separately from RAG, so turning retrieval off does not disable this context. They are not proof for a new finding.</li>
            </ul>
          </details>

          <div id="knowledge-roadmap" className="scroll-mt-24 space-y-4 border-t border-slate-200 pt-6">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-lg font-semibold text-[#111111]">Knowledge improvements delivered</h3>
              <span className="border border-[#cacac7] bg-[#f1f1f0] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#333333]">Implemented · evidence v2</span>
            </div>
            <ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-600">
              <li><strong className="text-[#111111]">Preserve evidence:</strong> original passages during emission, stable source/version references, exact quotation checks and evidence checkpoints for resumed runs.</li>
              <li><strong className="text-[#111111]">Use the corpus precisely:</strong> structured sections and metadata, contextual embeddings, section ranking, explicit scope filters and visible skipped-file reasons. Technical and corporate indexing publish one verified generation manifest while retaining the previous collections.</li>
              <li><strong className="text-[#111111]">Protect the finding:</strong> synthesis requires exact source candidate IDs, preserves unknown controls and preconditions, and restores omitted candidates within the configured target. Shared components no longer imply shared evidence.</li>
              <li><strong className="text-[#111111]">Inspect and verify:</strong> open a finding&apos;s full citation and source metadata, inspect retrieved passages and follow-up searches, and check which candidates reached final findings. Quality artifacts flag unverified citations and incomplete mitigations.</li>
            </ol>
            <p className="text-sm leading-6 text-slate-600">Regression tests exercise the identified failures. These checks establish implementation behavior; they do not establish a causal quality gain on production scans. Compare repeated runs with fixed input, architecture, control ledger, corpus, model settings and reviewer examples, using blind review.</p>
            <p className="text-sm leading-6 text-slate-600"><strong className="text-[#111111]">For example:</strong> if a role&apos;s grants are unknown, a technical guide can suggest checks but cannot establish actual permissions. An applicable configuration export may narrow the risk; without one, the finding must preserve the verification question.</p>
            <p className="text-xs leading-5 text-slate-500">Repository references: <code>knowledge_base/README.md</code> and <code>docs/architecture/rag.md</code>. Historical traces are not backfilled with evidence that was never captured.</p>
          </div>
        </Section>

        <Section id="workflow" eyebrow="07 / Product flow" title="Local analysis workflow">
          <div className="overflow-x-auto border border-slate-200 bg-[#fcfcfb] p-5">
            <div className="flex min-w-[680px] items-center gap-3 text-center text-xs">
              {[
                ['Browser', 'localhost:3000'], ['Next.js', 'admit + status'], ['pipeline-worker', 'lease + LangGraph'], ['Ollama', 'quick + deep'], ['Workspace', 'SQLite + artifacts'],
              ].map(([title, subtitle], index, list) => (
                <div key={title} className="contents"><div className="flex-1 border border-slate-300 bg-white px-3 py-4"><strong className="block text-[#111111]">{title}</strong><span className="mt-1 block text-[10px] text-slate-500">{subtitle}</span></div>{index < list.length - 1 && <span className="text-lg text-[#111111]">→</span>}</div>
              ))}
            </div>
            <p className="mt-4 text-center text-xs text-slate-500">Next.js admits the run. pipeline-worker claims it, executes LangGraph, and writes progress to JSONL plus the workspace. Restarting the UI does not abort a claimed run.</p>
          </div>
          <p className="text-sm leading-6 text-slate-600">Create or select a project on the Analyses page, open <strong>Run analysis</strong>, provide a system description, choose the model profile and start. The result page streams progress and keeps completed analyses in the selected project.</p>
          <div className="border border-[#cacac7] bg-white p-4 text-sm leading-6 text-slate-600">
            <strong className="text-[#111111]">Reproducible runs:</strong> every result includes a <strong>Run inputs</strong> section with the original request, document references and resolved execution snapshot. Copy or download the bundle, choose <strong>Use as new run</strong>, or import any completed run from the analysis form. Reuse creates a new independent run and never changes the source result.
          </div>
          <div className="border border-[#cacac7] bg-[#f1f1f0] p-4 text-sm leading-6 text-[#555555]">
            <strong className="text-[#111111]">Unfinished work is protected:</strong> Run Analysis automatically saves the system/project, description or extracted upload text, selected provider and models, analysts, mode, debate rounds and target in <code className="font-mono text-xs">sessionStorage</code>. Navigating to Knowledge or another section and returning restores the draft; a full reload does too. The draft belongs to that browser tab and is removed only after <code className="font-mono text-xs">POST /analyze</code> returns <code className="font-mono text-xs">202 Accepted</code>.
          </div>
        </Section>

        <Section id="context-coverage" eyebrow="07a / Coverage" title="Large context does not guarantee full document coverage">
          <div className="border border-[#cacac7] bg-[#fcfcfb] px-5 py-4 text-sm leading-6 text-slate-700">
            A model context window is the capacity of one call. Each stage receives its own request. New runs retain original source sections and pass them into analysis and finding review. <strong>Accepted files and a completed run do not prove that every fact or attack path was assessed.</strong> Total run tokens include repeated prompts and outputs; they do not measure source coverage.
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {[
              ['Input capacity', 'The analysis API accepts up to 20 upload IDs and 500,000 string code units of combined input and resolved uploads. Analysis uploads allow 10 MiB per file. These limits are separate from Knowledge ingestion.'],
              ['Section extraction', 'Original source windows retain every character after secret redaction, with stable SRC IDs and offsets. Complete windows are packed against the configured model context; a fitting bundle uses one pass. Failed or unattempted extraction blocks downstream analysis.'],
              ['What analysts actually see', 'Analysts receive original source passages alongside scoped structured architecture. If all sources cannot fit together, every section is delivered in complete groups. Shared-component cross-document passes and a bounded source lookup help reconcile qualifications. New runs retain all ledger statements.'],
              ['Evidence passed between stages', 'Source-backed notes are not silently block-trimmed. If component-name matches are too broad, a model reviews every original section for relevance to the candidate batch. Relevant and uncertain sections, citations and adjacent qualifications are retained in full for debate, synthesis and DREAD. This adds inference calls and is not a guarantee of semantic completeness. Oversized retained evidence still raises an error.'],
              ['Context versus output caps', 'Output settings limit generation. Source budgets reserve output space and prompt overhead within the configured context. Supported Qwen2/Qwen3 tokenizers use the vocabulary and merge rules from local Ollama metadata; other models retain approximate sizing. Set Ollama NUM_CTX within the installed model capacity. Hosted capacities use MODEL_CONTEXT_WINDOWS entries keyed by exact model ID, with verified Kimi defaults. Original SRC passages are never head/tail compacted.'],
              ['Retrieval is selective', 'RAG evidence budgets are 9,000 characters for analysts, 8,000 for Red/Blue, 10,000 for synthesis and 6,500 for validation. Passage windows are capped at 2,400 characters, with 40 retrieval queries per run. Indexed content is not necessarily retrieved or used.'],
            ].map(([title, description]) => (
              <div key={title} className="border border-slate-200 bg-white p-5">
                <h3 className="font-semibold text-[#111111]">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
              </div>
            ))}
          </div>
          <div className="border border-slate-200 bg-white p-5 text-sm leading-6 text-slate-600"><strong>Configure the real capacity before a large run.</strong> Set <code>MODEL_CONTEXT_WINDOWS</code> to a JSON object mapping each exact hosted model ID to its verified context tokens, then restart. Kimi K2.6 and K3 now use verified defaults; explicit settings override them. Inputs over 18,000 characters using unknown hosted models are rejected before inference with MODEL_CONTEXT_UNVERIFIED. Capacity changes invalidate incompatible resume fingerprints. Larger sources may require more calls; a coverage gate can stop the run before debate instead of presenting incomplete analysis as complete.</div>
          <p className="text-sm leading-6 text-slate-600"><strong>Example: six architecture Markdown files.</strong> Six files of 20,000 characters total 120,000 characters, within the admission limit. The full bundle travels together when it fits the configured context; otherwise all source sections receive analysis passes. Original passages can connect a rule in file six to a workflow in file one. Implicit dependencies and undeclared aliases can still be missed; delivery does not prove understanding.</p>
          <div className="border border-slate-200 bg-[#fcfcfb] p-5">
            <h3 className="font-semibold text-[#111111]">Before spending on another large scan</h3>
            <p className="mt-3 text-sm leading-6 text-slate-600">Paid prose and structured calls reserve budget before dispatch. Reported usage replaces the reservation even when response validation fails; missing usage keeps the reservation. The synthetic Kimi acceptance harness enforces ten attempts before dispatch and a USD 1 ceiling using configured rates. Offline SDK transport checks do not establish live provider availability or model quality.</p>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-600">
              <li>Check Run inputs for every intended source and the correct target, scope and model configuration.</li>
              <li>Inspect Source coverage in Architecture: retained sections, failed extraction, successful analyst delivery, and expandable original passages. Check components, flows and cross-document rules.</li>
              <li>Use a manual expected-evidence checklist spanning every file, including late-file facts and cross-file dependencies. This check is not automated today.</li>
              <li>For a controlled quality experiment, keep inputs and models fixed and begin with one debate round. This is not an exhaustive audit configuration.</li>
            </ol>
          </div>
          <p className="text-sm leading-6 text-slate-600"><strong>Implemented:</strong> complete source retention, context-aware grouping, source IDs and offsets, extraction and pre-debate delivery gates, original evidence in review, shared-component reconciliation and a six-document regression fixture. <strong>Remaining limits:</strong> context sizing is approximate, unlisted hosted capacities require manual configuration, and reconciliation uses exact parsed names and lexical retrieval. Tests establish delivery behavior, not production-model accuracy.</p>
        </Section>

        <Section id="finding-quality" eyebrow="07b / Interpretation" title="Interpret finding quality and DREAD scores">
          <p className="text-sm leading-6 text-slate-600">Queued, running and unknown execution states cannot certify an empty review. Only a completed run can report a completed result with no findings. Reference matching and lexical relevance checks do not establish that a claim is semantically supported; acceptance still requires review of the original source and the model output.</p>
          <p className="mt-3 text-sm leading-6 text-slate-600">Acceptance has separate scopes. The offline workflow check exercises the production pipeline with scripted model responses and isolated storage. Local and Kimi acceptance runs assess debate on a fictional system; they do not certify the complete analysis workflow. A debate round requires one Red response and one Blue response. Judge commentary cannot replace either response. Failed or interrupted checks remain failed in their saved evidence.</p>
          <p className="text-sm leading-6 text-slate-600">Completed analyst checkpoints save findings together with the original source IDs they processed. Resume reuses an analyst only when its required source coverage is recorded, and repeats dependent stages if that coverage is missing or incomplete. Older checkpoints remain readable, but an empty findings list does not establish coverage.</p>
          <p className="text-sm leading-6 text-slate-600">The current checks distinguish system dependencies from investigated or adjacent context, avoid inferring controls from citation URLs, retain methodology lineage when merging findings, and treat essential unverified preconditions as conditional evidence. Where detected, those preconditions cap existence-confidence at 69%; confidence is separate from potential severity. Conflicting control claims remain unknown, and an unlisted control is never assumed absent. Architecture quotations are checked against original SRC sections; an unverified quote requires review and caps confidence. Provider-reported truncation of evidence notes blocks emission. Quality <code className="font-mono text-xs">passed</code> does not use a minimum finding count; it fails on unverified or unlinked citations and incomplete mitigations.</p>
          <p className="text-sm leading-6 text-slate-600">DREAD averages five independently assessed dimensions and rounds to one decimal. <strong>Low: below 4.0; Medium: 4.0–6.4; High: 6.5–7.9; Critical: 8.0–10.</strong> Missing or invalid dimensions remain unscored. Several valid scores can all fall in Medium; inspect the dimensions and rationale rather than expecting a forced distribution.</p>
          <p className="text-sm leading-6 text-slate-600">Results expose score dimensions, status and conditional interpretation where available. Unknown configuration is not a disabled control. Diagram omission markers describe hidden graph detail, and persisted progress restores phase counts after reload. These improvements do not certify complete source coverage.</p>
          <div className="border border-[#cacac7] bg-[#f1f1f0] p-4 text-sm leading-6 text-[#555555]"><strong>Historical runs:</strong> display and score-integrity fixes may improve how an existing result is shown. Its generated evidence remains historical; corrected generation requires a new run. Prompt versioning prevents reuse of incompatible older checkpoints.</div>
          <p className="text-sm leading-6 text-slate-600">Large shared-component groups are reviewed through pairs of smaller source groups when they exceed the model context. Every pair of related sections is delivered together in a primary or reconciliation pass, preserving the original text. This requires additional calls and does not certify reasoning across every multi-section dependency. Missing source delivery still blocks the run.</p>
          <p className="text-xs leading-5 text-slate-500">Maintainers: update docs/architecture/context-and-coverage.md and these sections together when changing coverage or scoring behavior. Provider output settings are documented in docs/architecture/llm-token-limits.md. Planned improvements must stay labeled separately from implemented behavior.</p>
        </Section>

        <Section id="identifiers" eyebrow="08 / Results" title="Readable threat identifiers">
          <p className="text-sm leading-6 text-slate-600">Every finding has two identities. The internal <code className="font-mono text-xs">id</code> remains an opaque stable key for database updates and API compatibility. The UI, reports and exports use <code className="font-mono text-xs">displayId</code>, a short category prefix plus a per-analysis sequence.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[['WEB-01', 'Web and API'], ['INF-01', 'Infrastructure'], ['IAM-01', 'Identity and access'], ['DAT-01', 'Data stores'], ['AI-01', 'AI and GenAI'], ['AGE-01', 'Agentic systems'], ['SUP-01', 'Supply chain'], ['SEC-01', 'General security']].map(([id, label]) => <div key={id} className="border border-slate-200 bg-white p-3"><code className="font-mono text-xs font-bold text-[#111111]">{id}</code><p className="mt-1 text-xs text-slate-500">{label}</p></div>)}
          </div>
        </Section>

        <Section id="api" eyebrow="09 / Automation" title="API reference">
          <p className="text-sm leading-6 text-slate-600">The API mirrors the local UI. Use the origin shown by <code className="font-mono text-xs">pnpm dev</code>; the default base URL is <code className="font-mono text-xs">http://localhost:3000/api/v1</code>. Run states are imported from the shared contract: <code className="font-mono text-xs">{ANALYSIS_STATUSES.join(' | ')}</code>.</p>
          <div className="overflow-x-auto border border-slate-200 bg-white"><table className="w-full text-left"><thead className="bg-[#fcfcfb] text-[11px] uppercase tracking-wider text-slate-500"><tr><th className="px-3 py-3">Method</th><th className="px-3 py-3">Path</th><th className="px-3 py-3">Purpose</th></tr></thead><tbody>
            {PUBLIC_API_ENDPOINTS.map(([method, path, purpose]) => (
              <Endpoint key={`${method}:${path}`} method={method} path={path} purpose={purpose} />
            ))}
          </tbody></table></div>
          <h3 className="text-sm font-semibold text-[#111111]">Start an analysis</h3>
          <CodeBlock>{`$body = @{
  systemName = "Digital Banking Platform"
  input = "A Next.js frontend calls an API gateway..."
  config = @{
    provider = "ollama"
    allowedProviders = @("ollama")
    executionProfile = "local_efficient"
    allowedProfiles = @("local_efficient")
    quickModel = "qwen3.5:4b"
    deepModel = "qwen3.5:9b"
    enabledAnalysts = @("stride", "pasta", "attack_tree")
    executionMode = "hybrid"
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post \`
  -Uri "http://localhost:3000/api/v1/analyze" \`
  -ContentType "application/json" \`
  -Body $body`}</CodeBlock>
          <h3 className="text-sm font-semibold text-[#111111]">Read a result</h3>
          <CodeBlock>{`Invoke-RestMethod "http://localhost:3000/api/v1/results/<analysis-id>"

# Alternative formats
Invoke-WebRequest "http://localhost:3000/api/v1/results/<analysis-id>?format=markdown"
Invoke-WebRequest "http://localhost:3000/api/v1/results/<analysis-id>?format=csv"
Invoke-RestMethod "http://localhost:3000/api/v1/results/<analysis-id>?format=inputs"`}</CodeBlock>
          <div className="border border-slate-200 bg-[#fcfcfb] p-4 text-sm text-slate-600"><strong className="text-[#111111]">Result identity:</strong> each threat includes the stable internal <code className="font-mono text-xs">id</code> and readable <code className="font-mono text-xs">displayId</code>. Use the internal ID for PATCH routes; show the display ID to people.</div>
        </Section>

        <Section id="troubleshooting" eyebrow="10 / Operations" title="Troubleshooting">
          <div className="space-y-3">
            {[
              ['The analysis stays pending', 'POST /analyze only enqueues. Without pipeline-worker the run never leaves pending. Health shows Pipeline worker down when the executor is missing. pnpm dev starts the worker; pnpm dev:next does not. Start pnpm pipeline:worker in another terminal, or use pnpm dev. In Docker, the worker service must be running (app depends on it). Refreshing the page does not start the pipeline.'],
              ['Changes appear in the UI but not in analysis', 'Next.js hot reload does not reload the separate pipeline-worker. After changing agents, prompts or pipeline code, let active work finish and restart pnpm dev before launching another validation run. Confirm both Next Ready and Pipeline worker started in the startup log. Worker liveness confirms that a process is alive; it does not verify that it loaded your latest edits.'],
              ['Provider billing blocked the run', 'Insufficient balance or exhausted billing quota requires restoring billing with the model provider. A 429 can mean billing exhaustion, not temporary throttling. Argus stops queued model calls in that run, preserves completed phase outputs, and marks unfinished analysis partial (failed if architecture extraction never completed). Calls already in flight may finish. Unscored findings stay excluded from severity counts. After billing is restored, use compatible phase checkpoints to resume; do not repeatedly start fresh scans. Older runs can show several failed stages caused by the same billing rejection.'],
              ['Ollama responds but a model is missing', 'An HTTP 200 from Ollama proves the server is reachable, not that a selected model is installed. Check ollama list and select installed quick/deep models, or install the exact requested tags. The analysis API returns OLLAMA_MODEL_MISSING before creating a run and lists the missing and available models. Model presets show installed models when inventory is available. After changing models, start a new run from saved inputs; incompatible checkpoints cannot be resumed.'],
              ['Ollama is down', 'Run ollama list, then open http://localhost:11434/api/tags. Restart Ollama if the endpoint does not answer.'],
              ['Chroma is down', 'The masthead shows RAG not ready. Run analysis blocks a RAG-on scan until retrieval is usable. Start Chroma with pnpm services:up, or without Docker: uvx --from chromadb chroma run --path ./chroma-data. Next.js being up does not start Chroma.'],
              ['The index is ready but RAG temporarily is not', 'A ready index confirms that vectors were built and match the corpus. Live RAG readiness also probes the configured embedding model. Ollama can take several seconds to load a cold embedding model after another model used memory. Wait for the probe to finish and check again. The health panel reports Chroma and embedding failures separately.'],
              ['A phase hangs with no new logs', 'The periodic telemetry line is informational, not a 60-second watchdog. PIPELINE_PHASE_TIMEOUT_MS is the base phase budget; analysts scale it by source-pass count, and debate rounds scale it by sequential batch waves (batch count divided by concurrency, rounded up). Ollama runs debate batches serially. These budgets are capped at the global budget without reducing candidates or evidence checks. Source-pass and batch-plan logs identify the workload. STRUCTURED_TIMEOUT_MS bounds individual structured calls, and the original PIPELINE_TIMEOUT_MS deadline remains enforced.'],
              ['Progress after a page reload', 'Status, telemetry and live streaming replay the worker’s persisted events. Local projects read progress.jsonl and telemetry.jsonl directly; PostgreSQL deployments read run_artifacts. Live logs are append-only records, while saved checkpoints retain checksum verification. Open Telemetry and agent logs to inspect the latest activity and phase failures.'],
              ['Evidence notes reached the output limit', 'The note-writing model has its own output allowance, even when the structured-emission model has a larger capacity. Requested notes are bounded by both allowances; original source passages remain complete. Prose calls use normal text generation and structured calls apply their schema separately. A truncated response fails the phase instead of becoming a complete assessment. Inspect the phase error before retrying.'],
              ['An analysis phase exceeded its time budget', 'This identifies the overall phase deadline, rather than an individual model-call timeout. Inspect the phase workload and configured budgets before resuming. Internal error details remain in server logs.'],
              ['Red / Blue dialogue and quality', 'One round means one Red turn followed by one Blue turn. Two configured rounds give each team two turns for every selected candidate, even after early agreement. Later turns respond to the preceding exchange: Red addresses the previous Blue position, then Blue addresses the current Red reply. Consensus is assessed after the final Blue turn; the judge reviews disagreements and proposed rejections afterward. A judge ruling is distinct from team consensus. Intermediate results are provisional. Applicability and severity remain separate decisions. Copied reasoning receives one independent reassessment; persistent copying, repeated turns or unavailable review remain unresolved. Rejected candidates are never automatically promoted to medium. Historical debates retain their original text.'],
              ['Synthesis planning notes were truncated', 'The synthesis plan uses a schema with a required entry for every candidate, bounded notes and valid source references. When the global plan cannot fit, planning runs per batch. One additional retrieval question is supported per planning call. Final emission still receives the original architecture and candidate evidence. Truncated responses are not silently accepted as complete.'],
              ['A completed run contains unscored findings', 'Execution status and assessment quality are separate. Zero placeholders on an unresolved scenario are shown as Unscored and excluded from severity counts. DREAD requires exactly one validation per input ID. If output remains truncated, it splits the batch while retaining every finding. An unscored result cannot pass the quality check.'],
              ['A verified citation does not explain the finding', 'Citation verification checks that the quotation exists in its original source. Component linkage currently uses literal matching, not semantic proof that the passage supports the proposed risk. Review the reasoning, documented controls and unresolved assumptions in the debate and final assessment. A verified reference alone is not evidence that a vulnerability exists.'],
              ['Provider compatibility after workflow changes', 'The regression suite checks planning and schema contracts for Ollama, Kimi, Gemini, Cursor and Bedrock without calling paid APIs. Prompt-based providers receive the input schema even when output parsing includes transformations. These checks do not verify live provider availability or quota. Ollama tokenizer and transport changes remain local to Ollama.'],
              ['Local validation calls time out while queued', 'Ollama validation batches run serially so another batch does not consume a model-call timeout waiting for the same local model. The validation phase budget scales with sequential batch waves while the global deadline remains enforced. Hosted providers retain the configured validation concurrency.'],
              ['A stopped local call keeps occupying Ollama', 'Cancellation and call deadlines propagate to the individual HTTP request, including while it waits for headers or its first response token. Stop persists cancelRequestedAt; the worker observes it and aborts in-flight Ollama requests. Closing one request does not abort other calls on the shared client.'],
              ['A completed phase appears incomplete when resuming', 'Updates to the same phase checkpoint are written in order together with their checksums. A partial-round checkpoint cannot overwrite the later completed-round marker.'],
              ['A synthesis batch falls back because of candidate references', 'Each batch’s output schema restricts sourceCandidateIds to the actual candidate IDs in that batch. Invalid references receive validation feedback and bounded retries. If the batch still fails, its diagnostic distinguishes execution errors from references outside the batch, and the run remains marked as degraded.'],
              ['Results shows PARTIAL with Pipeline timed out', 'That label is only for the overall pipeline budget (PIPELINE_TIMEOUT_MS). Optional control-pair assessment uses 90s and up to 40 pairs per framework. Failures preserve deterministic candidates and show failed/partial status for that standard. The overall pipeline budget still applies. A model-call timeout surfaces as The model call timed out. Resume from DREAD to rerun only the overlay.'],
              ['Reindex is disabled', 'This is expected while a job runs or when the corpus fingerprint matches and live vector checks pass. Missing vectors or a failed job make recovery available. After fixing the cause, retry from Knowledge; unchanged technical chunks are reused.'],
              ['The indexer cannot embed documents', 'Confirm Ollama is reachable at OLLAMA_BASE_URL. The current indexer uses Ollama /api/embed and automatically pulls a missing embedding model before resuming the same job.'],
              ['The model runs out of memory', 'Use qwen3.5:4b for both roles and lower OLLAMA_QUICK_NUM_CTX and OLLAMA_DEEP_NUM_CTX to 8192.'],
              ['A diagram cannot render', 'Argus rebuilds diagrams from structured architecture data. The component and flow tables remain the authoritative fallback.'],
              ['Port 3000 is occupied', 'Use the URL printed by Next.js, commonly localhost:3001, for both the browser and API commands.'],
            ].map(([title, copy]) => <details key={title} className="border border-slate-200 bg-white p-4"><summary className="cursor-pointer text-sm font-semibold text-[#111111]">{title}</summary><p className="mt-2 text-sm leading-6 text-slate-600">{copy}</p></details>)}
          </div>
        </Section>
      </article>
    </div>
  )
}
