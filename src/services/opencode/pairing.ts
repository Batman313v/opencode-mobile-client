import { Capacitor } from '@capacitor/core'
import { checkServerHealth } from './health'

/** A one-time pairing code and every address the server reported it reachable at. */
export interface PairingLink {
  urls: string[]
  code: string
}

export type PairingResult =
  | { type: 'paired'; url: string; token: string }
  | { type: 'expired' }
  | { type: 'unreachable' }

const CODE = /^[A-Za-z0-9_-]+$/
const ATTEMPT_TIMEOUT_MS = 5000

/** Thrown when a server explicitly rejects the code (401): proof it expired or was already redeemed. */
export class PairingUnauthorizedError extends Error {}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value.trim())
  } catch {
    return undefined
  }
}

/** A clean http(s) server origin without credentials, query, or fragment. */
function serverAddress(value: string): string | undefined {
  const url = parseUrl(value)

  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined
  if (url.username || url.password || url.search || url.hash) return undefined

  return url.origin
}

/**
 * Parses `opencode pair` output: either the QR payload, which carries the one-time code with every
 * reachable server address as {"code","urls"} JSON, or a plain pairing link of the form
 * http://host:port/auth/connect/<code>. Returns undefined for anything else.
 */
export function parsePairingInput(value: string): PairingLink | undefined {
  const trimmed = value.trim()

  if (!trimmed) return undefined

  if (trimmed.startsWith('{')) {
    let payload: any

    try {
      payload = JSON.parse(trimmed)
    } catch {
      return undefined
    }

    if (!payload) return undefined

    const candidate = payload as { code?: unknown; urls?: unknown }

    if (typeof candidate.code !== 'string' || !CODE.test(candidate.code)) return undefined
    if (!Array.isArray(candidate.urls) || candidate.urls.length === 0) return undefined

    // Every address must be a clean server origin; one bad entry invalidates the whole payload.
    const urls = [...new Set<string>(candidate.urls.map((item: unknown) => String(item)))].map(serverAddress)

    if (urls.some((url) => url === undefined)) return undefined

    return { urls: urls.filter((url): url is string => url !== undefined), code: candidate.code }
  }

  const url = parseUrl(trimmed)

  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined

  const match = /^\/auth\/connect\/([^/]+)$/.exec(url.pathname)

  if (!match || !CODE.test(match[1])) return undefined

  const address = serverAddress(url.origin)

  if (!address) return undefined

  return { urls: [address], code: match[1] }
}

function isTailscaleHost(hostname: string): boolean {
  // Tailscale's CGNAT range is 100.64.0.0/10, i.e. first octet 100-127 on a dotted-quad IPv4 host.
  const parts = hostname.split('.')

  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) return false

  const first = Number(parts[0])

  return first >= 100 && first <= 127
}

/** Tries Tailscale addresses first so pairing lands on the tailnet whenever it is reachable. */
export function orderCandidates(urls: string[]): string[] {
  const tailscale: string[] = []
  const rest: string[] = []

  for (const url of urls) {
    const hostname = parseUrl(url)?.hostname ?? ''
    ;(isTailscaleHost(hostname) ? tailscale : rest).push(url)
  }

  return [...tailscale, ...rest]
}

/**
 * Extracts the one-time code from a QR payload, a pairing link, or a bare code string. A bare
 * code is only useful together with a user-supplied address (see pairingAddress), since
 * `opencode pair` may advertise 127.0.0.1 in its QR.
 */
export function pairingCode(value: string): string | undefined {
  const trimmed = value.trim()

  if (!trimmed) return undefined

  const parsed = parsePairingInput(trimmed)

  if (parsed) return parsed.code

  return CODE.test(trimmed) ? trimmed : undefined
}

/**
 * Builds the http origin for a user-supplied server address, e.g. "100.x.y.z" or "host:4096".
 * Accepts a bare host or IP (optionally with a scheme) and defaults to opencode's 4096 port when
 * none is given — the QR from `opencode pair` may only advertise 127.0.0.1, so this address is
 * where its code gets redeemed instead.
 */
export function pairingAddress(value: string): string | undefined {
  const v = value.trim().replace(/\/+$/, '')

  if (!v) return undefined

  const url = parseUrl(v.includes('://') ? v : `http://${v}`)

  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined
  if (url.username || url.password) return undefined

  // A bare host gets opencode's default port; an explicit one is kept as-is.
  const origin = `${url.protocol}//${url.hostname}`

  if (url.port) return `${origin}:${url.port}`
  return url.protocol === 'http:' ? `${origin}:4096` : origin
}

async function redeemAt(url: string, code: string): Promise<{ url: string; token: string }> {
  const target = `${url}/auth/connect/${encodeURIComponent(code)}`
  let status: number
  let body: unknown

  if (Capacitor.isNativePlatform()) {
    const { CapacitorHttp } = await import('@capacitor/core')

    try {
      const response = await (CapacitorHttp as any).request({
        url: target,
        method: 'GET',
        connectTimeout: ATTEMPT_TIMEOUT_MS,
        readTimeout: ATTEMPT_TIMEOUT_MS,
      })

      status = response.status
      body = response.data
    } catch (error: any) {
      // Some native HTTP stacks reject non-2xx responses with the status attached; a plain
      // network failure carries no status and counts as unreachable.
      if (!error?.status && !error?.statusCode) throw new Error('unreachable')

      status = Number(error.status ?? error.statusCode)
      body = error.data
    }
  } else {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)

    try {
      const response = await fetch(target, { signal: controller.signal, mode: 'cors' })

      status = response.status

      if (response.ok) body = await response.json().catch(() => undefined)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  if (status === 401) throw new PairingUnauthorizedError()

  const token = typeof (body as any)?.token === 'string' ? (body as any).token : ''

  if (status !== 200 || !token) throw new Error('unreachable')

  return { url, token }
}

/**
 * Redeems the code at every candidate address in parallel. The code is single-use, so at most one
 * attempt succeeds; the returned token works on all addresses of that server, and the preferred
 * (user-supplied, else Tailscale-first) address wins when it answered and accepts the token.
 */
export async function redeemPairing(link: PairingLink, preferredAddress?: string): Promise<PairingResult> {
  const urls = preferredAddress ? [preferredAddress, ...orderCandidates(link.urls.filter((url) => url !== preferredAddress))] : orderCandidates(link.urls)
  const attempts = urls.map((url) => redeemAt(url, link.code))

  // Whether the first address answered at all (200 or 401); a slow or unreachable one stays pending.
  const firstAnswered = attempts[0]?.then(
    () => true,
    (error: unknown) => error instanceof PairingUnauthorizedError,
  )

  try {
    const pairing = await Promise.any(attempts)

    return { type: 'paired', ...(await preferFirst(urls, pairing, firstAnswered)) }
  } catch (error: any) {
    // Only a server's answer proves the code is spent; addresses that could not be reached leave it valid.
    if (error instanceof AggregateError && error.errors.some((item: unknown) => item instanceof PairingUnauthorizedError)) {
      return { type: 'expired' }
    }

    return { type: 'unreachable' }
  }
}

async function preferFirst(
  urls: string[],
  pairing: { url: string; token: string },
  firstAnswered: Promise<boolean> | undefined,
): Promise<{ url: string; token: string }> {
  const first = urls[0]

  if (!first || first === pairing.url || !firstAnswered) return pairing

  // An address that has not answered within a second (a local one seen from elsewhere) is not waited for.
  const answered = await Promise.race([
    firstAnswered,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
  ])

  if (answered !== true) return pairing

  // The token works on every address of the server; keep the preferred one when it accepts it.
  const health = await checkServerHealth({
    baseUrl: first,
    username: 'opencode',
    password: pairing.token,
    timeoutMs: ATTEMPT_TIMEOUT_MS,
  })

  return health.status === 'connected' ? { url: first, token: pairing.token } : pairing
}
