import { request } from 'node:https'
import type { LookupOptions, LookupAddress } from 'node:dns'
import { resolveSafeWebhookUrl } from '@/lib/utils/ssrf'

/**
 * Always resolve to the single, pre-validated address regardless of the calling
 * convention Node uses. Since Node 20, Happy Eyeballs (`autoSelectFamily`, on by
 * default) invokes custom `lookup` hooks with `{ all: true }` and expects the
 * array callback form; older/explicit-family call sites use the scalar form.
 * Handling only one form here previously crashed every hostname-based webhook
 * (`ERR_INVALID_IP_ADDRESS`) because literal-IP targets skip `lookup` entirely
 * and never surfaced the bug.
 */
export function pinnedLookup(address: string, family: 4 | 6) {
  return (
    _hostname: string,
    options: LookupOptions & { all?: boolean | undefined },
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number
    ) => void
  ) => {
    if (options?.all) {
      callback(null, [{ address, family }])
    } else {
      callback(null, address, family)
    }
  }
}

export type WebhookDeliveryResult =
  | { ok: true; status: number; hostname: string }
  | { ok: false; hostname: string; error: string; status?: number }

/**
 * POST a webhook to the DNS address validated immediately before connecting.
 * `https.request` deliberately does not follow redirects, unlike `fetch`.
 */
export async function postSafeWebhook(
  rawUrl: string,
  headers: Record<string, string>,
  payload: string,
  timeoutMs: number
): Promise<WebhookDeliveryResult> {
  const safe = await resolveSafeWebhookUrl(rawUrl)
  if (!safe.ok) {
    return { ok: false, hostname: 'unknown', error: safe.error }
  }

  return new Promise((resolve) => {
    const req = request(
      safe.url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(payload).toString(),
        },
        timeout: timeoutMs,
        // Belt-and-suspenders: pin both the address family (skips Happy Eyeballs'
        // dual-stack lookup entirely) and the lookup hook (in case family alone
        // isn't honored by a future Node version).
        family: safe.family,
        lookup: pinnedLookup(safe.address, safe.family),
      },
      (res) => {
        res.resume()
        const status = res.statusCode ?? 0
        if (status >= 200 && status < 300) {
          resolve({ ok: true, status, hostname: safe.url.hostname })
          return
        }
        resolve({
          ok: false,
          status,
          hostname: safe.url.hostname,
          error: status >= 300 && status < 400 ? 'Webhook redirects are not allowed' : `HTTP ${status}`,
        })
      }
    )

    req.once('timeout', () => req.destroy(new Error('Webhook timed out')))
    req.once('error', (err) =>
      resolve({ ok: false, hostname: safe.url.hostname, error: err.message })
    )
    req.end(payload)
  })
}
