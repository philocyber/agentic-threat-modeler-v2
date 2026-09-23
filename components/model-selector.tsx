'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  CheckIcon,
  QuestionMarkCircleIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline'
import type { AnalysisConfig } from '@/lib/models/types'
import { PROVIDER_METADATA, type LLMProvider } from '@/lib/llm/providers'
import {
  INFERENCE_PROFILES,
  getCompatibleInferenceProfiles,
  getDefaultInferenceProfile,
  isLocalOnlyBoundary,
  type InferenceProfileId,
} from '@/lib/llm/execution-profiles'
import { ProviderCredentials } from '@/components/provider-credentials'
import { resolveOllamaModelSelection } from '@/lib/llm/local-model-selection'

type ModelSelectorProps = {
  value: Partial<AnalysisConfig>
  ollamaModels?: import('@/lib/models/types').HealthStatus['ollamaModels']
  onChange: (config: Partial<AnalysisConfig>) => void
}

const QUICK_PRESETS = ['qwen3.5:4b', 'qwen3:4b', 'qwen3:1.7b', 'qwen2.5:3b', 'llama3.2:3b']
const DEEP_PRESETS = ['qwen3.5:9b', 'qwen3:8b', 'qwen3.5:4b', 'qwen2.5:14b', 'llama3.1:8b']

const PROVIDERS: Array<{
  id: LLMProvider
  label: string
  shortLabel: string
  description: string
  quick: string
  deep: string
}> = [
  {
    id: 'ollama',
    label: PROVIDER_METADATA.ollama.label,
    shortLabel: 'Local',
    description: 'Private inference on this machine. Analysis context never leaves the local Ollama service.',
    quick: 'Configured local quick model',
    deep: 'Configured local deep model',
  },
  {
    id: 'google',
    label: PROVIDER_METADATA.google.label,
    shortLabel: 'Cloud',
    description: 'Gemini API models with large context, structured output and provider-side caching.',
    quick: 'GEMINI_QUICK_MODEL',
    deep: 'GEMINI_DEEP_MODEL',
  },
  {
    id: 'kimi',
    label: PROVIDER_METADATA.kimi.label,
    shortLabel: 'Cloud',
    description: 'Kimi API routing. K2.6 is the efficient tier and K3 is the deep reasoning tier by default.',
    quick: 'KIMI_QUICK_MODEL',
    deep: 'KIMI_DEEP_MODEL',
  },
  {
    id: 'bedrock',
    label: PROVIDER_METADATA.bedrock.label,
    shortLabel: 'Cloud',
    description: 'Claude models through AWS Bedrock, with AWS credentials and regional controls.',
    quick: 'BEDROCK_QUICK_MODEL',
    deep: 'BEDROCK_DEEP_MODEL',
  },
  {
    id: 'cursor',
    label: PROVIDER_METADATA.cursor.label,
    shortLabel: 'Cloud',
    description: `${PROVIDER_METADATA.cursor.privacy} Grok 4.7 is the default for both tiers. Fast is enabled for the quick tier when the account supports it. Temperature is not supported.`,
    quick: 'CURSOR_QUICK_MODEL · default grok-4.7 (Fast)',
    deep: 'CURSOR_DEEP_MODEL · default grok-4.7',
  },
]

const ANALYSTS = [
  { id: 'stride' as const, label: 'STRIDE', desc: 'Spoofing, Tampering, Repudiation, Info Disclosure, DoS, Elevation' },
  { id: 'pasta' as const, label: 'PASTA', desc: 'Attack simulation from attacker perspective' },
  { id: 'attack_tree' as const, label: 'Attack Trees', desc: 'Multi-step attack chain decomposition' },
]

function InfoTip({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <span className="group/help relative inline-flex">
      <button
        type="button"
        aria-describedby={id}
        aria-label={`About ${title}`}
        className="grid h-6 w-6 place-items-center text-[#666666] hover:text-[#111111]"
      >
        <QuestionMarkCircleIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-7 z-30 hidden w-64 -translate-x-1/2 border border-[#cacac7] bg-[#111111] p-3 text-left text-[11px] font-normal leading-5 text-white shadow-xl group-hover/help:block group-focus-within/help:block"
      >
        <strong className="block text-xs">{title}</strong>
        <span className="mt-1 block text-[#dce6e0]">{description}</span>
        <Link
          href="/docs#provider-routing"
          className="pointer-events-auto mt-2 inline-block font-semibold text-[#e4e4e2] underline underline-offset-2"
        >
          Read more
        </Link>
      </span>
    </span>
  )
}

function ModelInput({
  label,
  hint,
  value,
  presets,
  onChange,
}: {
  label: string
  hint: string
  value: string
  presets: string[]
  onChange: (v: string) => void
}) {
  const [showPresets, setShowPresets] = useState(false)

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label className="text-xs font-medium text-slate-700">{label}</label>
        <span className="text-right text-[11px] text-slate-600">{hint}</span>
      </div>
      <div className="relative">
        <input
          type="text"
          className="min-h-11 w-full border border-[#cacac7] bg-white px-3 pr-24 font-mono text-xs text-slate-800 outline-none focus:border-[#111111] focus:ring-2 focus:ring-[#111111]/20"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="model:tag"
        />
        <button
          type="button"
          className="absolute right-2 top-1/2 min-h-9 -translate-y-1/2 px-2 text-[11px] font-semibold text-[#666666] hover:text-[#111111]"
          aria-expanded={showPresets}
          aria-label={`Show preset models for ${label}`}
          onClick={() => setShowPresets((visible) => !visible)}
        >
          Presets
        </button>
      </div>
      {showPresets ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                onChange(preset)
                setShowPresets(false)
              }}
              className={`border px-2 py-1 font-mono text-[11px] ${
                value === preset
                  ? 'border-[#111111] bg-[#111111] text-white'
                  : 'border-[#cacac7] bg-white text-[#666666] hover:border-[#8da097]'
              }`}
            >
              {preset}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ModelSelector({ value, onChange, ollamaModels }: ModelSelectorProps) {
  const provider = (value.provider ?? 'ollama') as LLMProvider
  const localModels = resolveOllamaModelSelection(value, ollamaModels)
  const quickModel = provider === 'ollama'
    ? localModels.quickModel
    : value.quickModel ?? ''
  const deepModel = provider === 'ollama'
    ? localModels.deepModel
    : value.deepModel ?? ''
  const enabledAnalysts = value.enabledAnalysts ?? ['stride', 'pasta', 'attack_tree']
  const compatibleProfileIds = getCompatibleInferenceProfiles(provider)
  const requestedProfile = value.executionProfile ?? getDefaultInferenceProfile(provider)
  const executionProfile = compatibleProfileIds.includes(requestedProfile)
    ? requestedProfile
    : getDefaultInferenceProfile(provider)
  const allowedProviders = [provider]
  const localOnly = isLocalOnlyBoundary(allowedProviders)
  const providerInfo = PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0]!
  const availableProfiles = INFERENCE_PROFILES.filter((profile) =>
    compatibleProfileIds.includes(profile.id),
  )

  useEffect(() => {
    if (provider !== 'ollama') return
    if (value.quickModel === quickModel && value.deepModel === deepModel) return
    onChange({ ...value, quickModel, deepModel })
  }, [deepModel, onChange, provider, quickModel, value])

  function update(next: Partial<AnalysisConfig>) {
    onChange({ ...value, ...next })
  }

  function selectProvider(id: LLMProvider) {
    const nextProfile = getDefaultInferenceProfile(id)
    const next: Partial<AnalysisConfig> = {
      ...value,
      provider: id,
      allowedProviders: [id],
      executionProfile: nextProfile,
      allowedProfiles: [nextProfile],
    }
    delete next.quickModel
    delete next.deepModel
    if (id === 'ollama') {
      if (ollamaModels?.quickModel) next.quickModel = ollamaModels.quickModel
      if (ollamaModels?.deepModel) next.deepModel = ollamaModels.deepModel
    }
    onChange(next)
  }

  function selectProfile(id: InferenceProfileId) {
    update({
      allowedProviders: [provider],
      executionProfile: id,
      allowedProfiles: [id],
    })
  }

  function toggleAnalyst(id: 'stride' | 'pasta' | 'attack_tree') {
    const updated = enabledAnalysts.includes(id)
      ? enabledAnalysts.filter((analyst) => analyst !== id)
      : [...enabledAnalysts, id]
    if (updated.length > 0) update({ enabledAnalysts: updated })
  }

  const fullPower = executionProfile === 'provider_full_power'
  const quickRoute = provider === 'ollama' ? quickModel : providerInfo.quick
  const deepRoute = provider === 'ollama' ? deepModel : providerInfo.deep
  const activeProfile = INFERENCE_PROFILES.find((profile) => profile.id === executionProfile)!
  const profileLabel = provider === 'ollama' && executionProfile === 'provider_full_power'
    ? 'Local Full Power'
    : provider === 'ollama' && executionProfile === 'adaptive_value'
      ? 'Adaptive Local'
      : activeProfile.label
  const routingBehavior = fullPower
    ? `Every LLM phase uses ${deepRoute}. This maximizes consistency and inference cost within ${providerInfo.label}.`
    : executionProfile === 'adaptive_value'
      ? `The run starts with the quick/deep split shown below. Any future quality-gate retry remains on ${providerInfo.label}; automatic rerouting is not enabled yet.`
      : `Mechanical phases use ${quickRoute}; analysis, debate and synthesis use ${deepRoute}.`

  return (
    <div className="space-y-6">
      <section aria-labelledby="vendor-boundary-title" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <h3 id="vendor-boundary-title" className="text-xs font-bold uppercase tracking-[0.08em] text-[#666666]">
              Inference provider
            </h3>
            <InfoTip
              id="vendor-boundary-help"
              title="Inference provider"
              description="Choose exactly one provider for this run. Every LLM phase and retry stays inside that provider boundary."
            />
          </div>
          <span className="text-[11px] text-[#666666]">Select one provider for the complete run</span>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {PROVIDERS.map((item) => {
            const selected = provider === item.id
            return (
              <label
                key={item.id}
                className={`relative cursor-pointer border p-3 transition-colors ${
                  selected ? 'border-[#111111] bg-[#f1f1f0]' : 'border-[#e4e4e2] bg-white hover:border-[#9fb0a7]'
                }`}
              >
                <span className="flex items-start gap-2.5">
                  <input
                    type="radio"
                    name="inference-provider"
                    checked={selected}
                    onChange={() => selectProvider(item.id)}
                    className="mt-0.5 h-4 w-4 accent-[#111111]"
                    aria-label={`Use ${item.label}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-[#111111]">{item.label}</span>
                    <span className="mt-0.5 block text-[10px] uppercase tracking-[0.08em] text-[#666666]">{item.shortLabel}</span>
                  </span>
                </span>
                <span className={`mt-3 block border px-2 py-1.5 text-center text-[10px] font-bold uppercase tracking-[0.08em] ${
                  selected
                    ? 'border-[#111111] bg-[#111111] text-white'
                    : 'border-[#e4e4e2] bg-[#fcfcfb] text-[#666666]'
                }`}>
                  {selected ? 'Selected provider' : 'Select provider'}
                </span>
              </label>
            )
          })}
        </div>
      </section>

      <section aria-labelledby="profile-boundary-title" className="space-y-3 border-t border-[#e9e3e5] pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <h3 id="profile-boundary-title" className="text-xs font-bold uppercase tracking-[0.08em] text-[#666666]">
              Execution profiles
            </h3>
            <InfoTip
              id="profile-boundary-help"
              title="Execution profile"
              description="Choose one execution strategy. The available profiles change with the selected provider."
            />
          </div>
          <span className="text-[11px] text-[#666666]">Options for {providerInfo.label}</span>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          {availableProfiles.map((profile) => {
            const active = executionProfile === profile.id
            const label = provider === 'ollama' && profile.id === 'provider_full_power'
              ? 'Local Full Power'
              : provider === 'ollama' && profile.id === 'adaptive_value'
                ? 'Adaptive Local'
                : profile.label
            return (
              <label
                key={profile.id}
                className={`cursor-pointer border p-3.5 transition-colors ${active ? 'border-[#111111] bg-[#f1f1f0]' : 'border-[#e4e4e2] bg-white hover:border-[#b8c5be]'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex items-start gap-2.5">
                    <input
                      type="radio"
                      name="execution-profile"
                      checked={active}
                      onChange={() => selectProfile(profile.id)}
                      className="mt-0.5 h-4 w-4 accent-[#111111]"
                      aria-label={`Use ${label}`}
                    />
                    <span>
                      <span className="block text-xs font-semibold text-[#111111]">{label}</span>
                      <span className="mt-1 block text-[11px] leading-5 text-[#666666]">{profile.description}</span>
                    </span>
                  </span>
                  {active ? <CheckIcon className="h-4 w-4 shrink-0 text-[#111111]" aria-hidden="true" /> : null}
                </div>
                <span className={`mt-3 inline-block border px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] ${
                  active
                    ? 'border-[#111111] bg-[#111111] text-white'
                    : 'border-[#e4e4e2] bg-[#fcfcfb] text-[#666666]'
                }`}>
                  {active ? 'Active profile' : 'Select profile'}
                </span>
              </label>
            )
          })}
        </div>
      </section>

      <section className={`border p-4 ${localOnly ? 'border-[#cacac7] bg-[#f1f1f0]' : 'border-[#cacac7] bg-[#fcfcfb]'}`}>
        <div className="flex items-start gap-3">
          <ShieldCheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-[#555555]" aria-hidden="true" />
          <div>
            <p className="text-xs font-semibold text-[#333333]">
              {localOnly ? 'Local-only boundary enforced' : 'Explicit routing boundary'}
            </p>
            <p className="mt-1 text-[11px] leading-5 text-[#666666]">
              {localOnly
                ? 'Every phase, retry and future quality-gate escalation remains on Ollama. A missing local model fails the run instead of sending data to cloud.'
                : `Every phase and retry stays on ${providerInfo.label}. This run has no automatic fallback to another vendor.`}
            </p>
            <Link href="/docs#quality-gate-boundary" className="mt-2 inline-block text-[11px] font-semibold text-[#111111] underline underline-offset-2">
              Read the routing and privacy contract
            </Link>
          </div>
        </div>
      </section>

      <section className="border border-[#e4e4e2] bg-white p-4" aria-labelledby="route-preview-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="route-preview-title" className="text-xs font-semibold text-[#333333]">Current route preview</h3>
          <span className="border border-[#e4e4e2] bg-[#fcfcfb] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[#666666]">
            {providerInfo.label} · {profileLabel}
          </span>
        </div>
        <div className="mt-3 grid gap-px border border-[#eee8ea] bg-[#eee8ea] sm:grid-cols-5">
          {[
            ['Parse', fullPower ? deepRoute : quickRoute],
            ['Analyze', deepRoute],
            ['Debate', deepRoute],
            ['Synthesize', deepRoute],
            ['Validate', fullPower ? deepRoute : quickRoute],
          ].map(([phase, model]) => (
            <div key={phase} className="min-w-0 bg-[#fcfcfb] p-2.5">
              <span className="block text-[9px] font-bold uppercase tracking-[0.08em] text-[#666666]">{phase}</span>
              <span className="mt-1 block truncate font-mono text-[10px] text-[#31483f]" title={model}>{model}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <div className="border border-[#eee8ea] bg-[#fcfcfb] p-3">
            <span className="block text-[9px] font-bold uppercase tracking-[0.08em] text-[#666666]">Data boundary</span>
            <p className="mt-1 text-[11px] leading-5 text-[#666666]">
              {localOnly
                ? 'Analysis context remains on this machine through Ollama.'
                : `Analysis context is sent to ${providerInfo.label}. No other vendor is authorized.`}
            </p>
          </div>
          <div className="border border-[#eee8ea] bg-[#fcfcfb] p-3 md:col-span-2">
            <span className="block text-[9px] font-bold uppercase tracking-[0.08em] text-[#666666]">Routing behavior</span>
            <p className="mt-1 text-[11px] leading-5 text-[#666666]">{routingBehavior}</p>
          </div>
        </div>
      </section>

      {provider === 'ollama' && ollamaModels?.reachable && (
        <p className="text-xs leading-5 text-[#666666]">
          Installed local models: {ollamaModels.availableModels.join(', ') || 'none'}. Presets below show installed models; other names must be installed before running.
        </p>
      )}
      {provider === 'ollama' ? (
        <div className="grid gap-4 md:grid-cols-2">
          <ModelInput
            label="Quick model"
            hint="Parser, PASTA, attack trees, validator"
            value={quickModel}
            presets={ollamaModels?.reachable ? ollamaModels.availableModels : QUICK_PRESETS}
            onChange={(model) => update({ quickModel: model })}
          />
          <ModelInput
            label="Deep model"
            hint="STRIDE, debate, synthesis"
            value={deepModel}
            presets={ollamaModels?.reachable ? ollamaModels.availableModels : DEEP_PRESETS}
            onChange={(model) => update({ deepModel: model })}
          />
        </div>
      ) : (
        <div className="border border-[#e4e4e2] bg-[#fcfcfb] px-4 py-3 text-xs leading-5 text-[#666666]">
          <strong className="text-[#333333]">{providerInfo.label}:</strong> model IDs come from the server configuration. Full Power maps every LLM phase to the configured deep tier; Optimized keeps the quick/deep split.
        </div>
      )}

      <ProviderCredentials key={provider} provider={provider} />

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[#666666]">Analysts</h3>
          <span className="text-[11px] text-[#666666]">Select at least one</span>
        </div>
        <div className="space-y-2">
          {ANALYSTS.map((analyst) => (
            <label
              key={analyst.id}
              className={`flex cursor-pointer items-start gap-3 border p-3 ${
                enabledAnalysts.includes(analyst.id)
                  ? 'border-[#9fb0a7] bg-[#f1f1f0]'
                  : 'border-[#e4e4e2] bg-white hover:border-[#b8c5be]'
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#111111]"
                checked={enabledAnalysts.includes(analyst.id)}
                onChange={() => toggleAnalyst(analyst.id)}
              />
              <span>
                <span className="block text-sm font-medium text-[#333333]">{analyst.label}</span>
                <span className="mt-0.5 block text-xs text-[#666666]">{analyst.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </section>
    </div>
  )
}
