import type { ServerSetupAnswers } from '@shared/types/server-setup.types'

export type ServerShareUrlResult =
  | {
      status: 'ready'
      /** Full URL encoded in the QR code and copied by "Copy link" (carries `#token=` when present). */
      shareUrl: string
      /** Bare origin safe to display in visible text (never contains `#token=`). */
      displayOrigin: string
      hasToken: boolean
      isPlaintextRemote: boolean
    }
  | { status: 'loopback-only'; reason: string }
  | { status: 'no-lan-address'; reason: string }

export interface BuildServerShareUrlInput {
  /** Current browser `window.location.origin` (e.g. `https://troupe.example.com`). */
  origin: string
  /** Current browser `window.location.hostname`. */
  hostname: string
  /** Server config from `GET /server/config` (optional if still loading or unavailable). */
  config: ServerSetupAnswers | null
  /** Detected LAN IPv4 address returned by `GET /server/config` when bound to `0.0.0.0`. */
  lanHost?: string
  /** Resolved bearer token from `getWebAuthToken()`, or `null` when ungated. */
  token: string | null
}

/** IPv4 reserves all of 127.0.0.0/8 for loopback, not only 127.0.0.1. */
function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  return octets[0] === 127
}

/** Drop one trailing DNS dot so `localhost.` and `app.localhost.` match loopback. */
function stripTerminalDnsDot(hostname: string): string {
  const h = hostname.trim().toLowerCase()
  return h.endsWith('.') ? h.slice(0, -1) : h
}

function isLoopbackHostname(hostname: string): boolean {
  const h = stripTerminalDnsDot(hostname)
  return (
    h === 'localhost' ||
    isIpv4Loopback(h) ||
    h === '::1' ||
    h === '[::1]' ||
    h.endsWith('.localhost')
  )
}

/**
 * True when {@link buildServerShareUrl} keeps the browser origin.
 * A loopback browser substitutes `lanHost` instead, so write admission for
 * that URL is the configured remote-write flag, not the loopback peer's.
 */
function shareUrlKeepsBrowserOrigin(origin: string, hostname: string): boolean {
  const cleanOrigin = origin.replace(/\/+$/, '')
  return Boolean(hostname && !isLoopbackHostname(hostname) && cleanOrigin)
}

/**
 * Write admission for the URL {@link buildServerShareUrl} will encode.
 * A kept browser origin uses the effective admission of this page (`/health`).
 * A substituted LAN host uses `allowRemoteWrites` from server config.
 */
export function shareLinkAllowsWrites(input: {
  origin: string
  hostname: string
  admitsWrites: boolean
  allowRemoteWrites: boolean
}): boolean {
  return shareUrlKeepsBrowserOrigin(input.origin, input.hostname)
    ? input.admitsWrites
    : input.allowRemoteWrites
}

function isWildcardBind(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === '0.0.0.0' || h === '::' || h === '[::]' || h === 'all' || h === 'any'
}

/**
 * Resolve the phone-scannable URL for a standalone `troupe-server`.
 *
 * - Non-loopback browser origin (LAN IP, mDNS hostname, Tailscale, HTTPS proxy):
 *   reuses `origin` directly so the QR preserves TLS / domain / reverse proxy.
 * - Loopback browser origin (`localhost`, `127.0.0.0/8`, `::1`):
 *   - If bound to `0.0.0.0` and `lanHost` was detected, substitutes `http://<lanHost>:<port>`.
 *   - If bound to `127.0.0.1`, returns `loopback-only` (never draws an unscannable `localhost` QR).
 *   - If bound to `0.0.0.0` without a detected `lanHost`, returns `no-lan-address`.
 *
 * When `token` is non-empty, appends `#token=<encoded>` (same fragment
 * convention `web-auth-token.ts`, `RestartingScreen.tsx`, and `WebAuth::share_url` use).
 */
export function buildServerShareUrl({
  origin,
  hostname,
  config,
  lanHost,
  token
}: BuildServerShareUrlInput): ServerShareUrlResult {
  const cleanOrigin = origin.replace(/\/+$/, '')
  let displayOrigin: string

  if (hostname && !isLoopbackHostname(hostname) && cleanOrigin) {
    displayOrigin = cleanOrigin
  } else if (config && isWildcardBind(config.host)) {
    const detected = lanHost?.trim()
    if (!detected) {
      return {
        status: 'no-lan-address',
        reason:
          'Could not detect a LAN IP address for this server. Open Karsa using its network address or run `troupe-server qr --host <ip>` on the host.'
      }
    }
    const hostPart =
      detected.includes(':') && !detected.startsWith('[') ? `[${detected}]` : detected
    displayOrigin = `http://${hostPart}:${config.port}`
  } else if (config) {
    return {
      status: 'loopback-only',
      reason:
        'This server is bound to localhost only (127.0.0.1), so other devices cannot reach it. Switch to all interfaces (0.0.0.0) in Server settings to connect from a phone.'
    }
  } else {
    return {
      status: 'no-lan-address',
      reason:
        'Open Karsa using this server’s network address or run `troupe-server qr` on the host to generate a phone-scannable QR code.'
    }
  }

  const cleanToken = token?.trim() || null
  const shareUrl = cleanToken
    ? `${displayOrigin}/#token=${encodeURIComponent(cleanToken)}`
    : `${displayOrigin}/`

  return {
    status: 'ready',
    shareUrl,
    displayOrigin,
    hasToken: cleanToken !== null,
    isPlaintextRemote: displayOrigin.startsWith('http://')
  }
}
