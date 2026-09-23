'use client'

import { useEffect, useState } from 'react'
import type { LLMProvider } from '@/lib/llm/providers'

type CloudProvider = Exclude<LLMProvider, 'ollama'>
type ProviderStatus = { configured: boolean; managedLocally: boolean }
type StatusMap = Record<CloudProvider, ProviderStatus>
type CheckResult = { ok: boolean; summary: string; details: string; hints: string[] }

const EMPTY_STATUS: StatusMap = {
  google: { configured: false, managedLocally: false },
  kimi: { configured: false, managedLocally: false },
  bedrock: { configured: false, managedLocally: false },
  cursor: { configured: false, managedLocally: false },
}

export function ProviderCredentials({ provider }: { provider: LLMProvider }) {
  const [statuses, setStatuses] = useState<StatusMap>(EMPTY_STATUS)
  const [readOnly, setReadOnly] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [kimiBaseUrl, setKimiBaseUrl] = useState<'https://api.moonshot.ai/v1' | 'https://api.moonshot.cn/v1'>(
    'https://api.moonshot.ai/v1',
  )
  const [showSecret, setShowSecret] = useState(false)
  const [region, setRegion] = useState('us-east-1')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CheckResult | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/v1/llm/credentials', { credentials: 'include', cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { providers?: StatusMap; readOnly?: boolean }) => {
        if (!cancelled && data.providers) setStatuses(data.providers)
        if (!cancelled) setReadOnly(data.readOnly === true)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  function applyCheck(check?: Partial<CheckResult>, fallback = 'Credential request failed') {
    setResult({
      ok: Boolean(check?.ok),
      summary: check?.summary || fallback,
      details: check?.details || '',
      hints: check?.hints || [],
    })
    setDetailsOpen(false)
  }

  async function checkSaved() {
    setBusy(true)
    setResult(null)
    try {
      const response = await fetch('/api/v1/llm/check', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      const data = await response.json()
      applyCheck(data, data.error_description || data.error)
    } catch (error) {
      applyCheck(undefined, error instanceof Error ? error.message : 'Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  async function saveAndCheck() {
    if (provider === 'ollama') return
    setBusy(true)
    setResult(null)
    const credentials = provider === 'bedrock'
      ? { provider, region, accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined }
      : provider === 'kimi'
        ? { provider, apiKey, baseUrl: kimiBaseUrl }
        : { provider, apiKey }
    try {
      const response = await fetch('/api/v1/llm/credentials', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      })
      const data = await response.json()
      if (data.providers) setStatuses(data.providers)
      applyCheck(data.check, data.error_description || data.error)
      if (response.ok && data.saved) {
        setApiKey('')
        setAccessKeyId('')
        setSecretAccessKey('')
        setSessionToken('')
      }
    } catch (error) {
      applyCheck(undefined, error instanceof Error ? error.message : 'Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  async function removeSaved() {
    if (provider === 'ollama' || !window.confirm(`Remove the saved ${provider} credentials from this machine?`)) return
    setBusy(true)
    setResult(null)
    try {
      const response = await fetch('/api/v1/llm/credentials', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      const data = await response.json()
      if (data.providers) setStatuses(data.providers)
      setResult({
        ok: response.ok,
        summary: response.ok ? 'Credentials removed from this machine' : (data.error_description || data.error),
        details: '',
        hints: [],
      })
    } catch (error) {
      applyCheck(undefined, error instanceof Error ? error.message : 'Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const status = provider === 'ollama' ? null : statuses[provider]
  const canSave = provider === 'bedrock'
    ? Boolean(region && accessKeyId && secretAccessKey)
    : provider !== 'ollama' && apiKey.length >= 8

  return (
    <div className="space-y-3 border border-[#e4e4e2] bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-[#333333]">Provider credentials</p>
            {status && (
              <span className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${status.configured ? 'text-[#333333]' : 'text-[#666666]'}`}>
                {status.configured ? 'Configured' : 'Not configured'}
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] leading-5 text-[#666666]">
            {provider === 'ollama'
              ? 'Checks the local Ollama service and selected models.'
              : 'Validated server-side, stored only in the ignored .env.local file, and never returned to the browser.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(provider === 'ollama' || status?.configured) && (
            <button type="button" onClick={checkSaved} disabled={busy} className="min-h-10 border border-[#cacac7] px-3 text-xs font-semibold text-[#444444] hover:bg-[#f1f1f0] disabled:opacity-50">
              Check saved key
            </button>
          )}
          {status?.managedLocally && !readOnly && (
            <button type="button" onClick={removeSaved} disabled={busy} className="min-h-10 px-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
              Remove
            </button>
          )}
        </div>
      </div>

      {provider !== 'ollama' && readOnly && (
        <p className="border-t border-[#eee8ea] pt-3 text-[11px] leading-5 text-[#666666]">
          Credentials are managed by the local installer. Rerun setup or edit the ignored .env.docker file, then restart Argus to update this provider.
        </p>
      )}

      {provider !== 'ollama' && !readOnly && (
        <div className="space-y-3 border-t border-[#eee8ea] pt-3">
          {provider === 'bedrock' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <CredentialInput label="AWS region" value={region} onChange={setRegion} placeholder="us-east-1" />
              <CredentialInput label="Access key ID" value={accessKeyId} onChange={setAccessKeyId} secret={!showSecret} placeholder="AKIA..." />
              <CredentialInput label="Secret access key" value={secretAccessKey} onChange={setSecretAccessKey} secret={!showSecret} placeholder="Enter secret access key" />
              <CredentialInput label="Session token (optional)" value={sessionToken} onChange={setSessionToken} secret={!showSecret} placeholder="Temporary credentials only" />
            </div>
          ) : (
            <div className={provider === 'kimi' ? 'grid gap-3 sm:grid-cols-2' : undefined}>
              <CredentialInput
                label={
                  provider === 'google'
                    ? 'Google API key'
                    : provider === 'cursor'
                      ? 'Cursor API key'
                      : 'Moonshot API key'
                }
                value={apiKey}
                onChange={setApiKey}
                secret={!showSecret}
                placeholder={status?.configured ? 'Enter a new key to replace the saved one' : 'Paste provider key'}
              />
              {provider === 'kimi' ? (
                <label className="block">
                  <span className="mb-1.5 block text-[11px] font-semibold text-[#666666]">API region</span>
                  <select
                    value={kimiBaseUrl}
                    onChange={(event) => setKimiBaseUrl(event.target.value as typeof kimiBaseUrl)}
                    className="min-h-10 w-full border border-[#cacac7] bg-[#ffffff] px-3 text-xs text-[#111111] outline-none focus:border-[#475cc7] focus:ring-2 focus:ring-[#475cc7]/15"
                  >
                    <option value="https://api.moonshot.ai/v1">Global · api.moonshot.ai</option>
                    <option value="https://api.moonshot.cn/v1">China · api.moonshot.cn</option>
                  </select>
                </label>
              ) : null}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[#666666]">
              <input type="checkbox" checked={showSecret} onChange={(event) => setShowSecret(event.target.checked)} />
              Show credential while editing
            </label>
            <button type="button" onClick={saveAndCheck} disabled={busy || !canSave} className="min-h-10 bg-[#111111] px-4 text-xs font-semibold text-white hover:bg-[#333333] disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? 'Validating...' : status?.configured ? 'Replace & check' : 'Save & check'}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div role="status" aria-live="polite" className={`border px-3 py-2 text-xs ${result.ok ? 'border-[#cacac7] bg-[#f1f1f0] text-[#333333]' : 'border-red-300 bg-red-50 text-red-950'}`}>
          <p className="font-semibold">{result.ok ? 'OK' : 'Failed'}: {result.summary}</p>
          {(result.details || result.hints.length > 0) && (
            <div className="mt-2">
              <button type="button" onClick={() => setDetailsOpen((open) => !open)} className="text-[11px] font-semibold underline underline-offset-2">
                {detailsOpen ? 'Hide details' : 'Show details'}
              </button>
              {detailsOpen && (
                <div className="mt-2 space-y-2">
                  {result.details && <pre className="max-h-48 overflow-auto whitespace-pre-wrap border border-black/5 bg-white/70 p-2 font-mono text-[11px]">{result.details}</pre>}
                  {result.hints.length > 0 && <ul className="list-disc space-y-1 pl-4 text-[11px]">{result.hints.map((hint) => <li key={hint}>{hint}</li>)}</ul>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CredentialInput({ label, value, onChange, placeholder, secret = false }: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  secret?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold text-[#666666]">{label}</span>
      <input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        spellCheck={false}
        className="min-h-10 w-full border border-[#cacac7] bg-[#ffffff] px-3 font-mono text-xs text-[#111111] outline-none focus:border-[#475cc7] focus:ring-2 focus:ring-[#475cc7]/15"
      />
    </label>
  )
}
