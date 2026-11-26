/**
 * Karsa's registry overlay in the renderer: per-agent display name, logo and
 * brand colour, keyed by registry agent id.
 *
 * Seeded at import from the bundled `troupe.json`, so first paint already has
 * the brand colours, then replaced by the host's copy (`get_acp_agent_overlay`),
 * which a merge in the registry repository changes without a Karsa build.
 */

import type { AcpAgentOverride, AgentBrandColor } from '@shared/types/acp-catalog.types'
import bundledOverlay from '@/assets/agent-icons/acp/troupe.json'
import { getAcpTransport } from '@/lib/acp-transport'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import { logFrontendError } from '@/lib/log-api'

/** What the overlay changes about one agent. `icon` is already sanitized. */
export interface AgentPresentation {
  name?: string
  icon?: string
  brandColor?: AgentBrandColor
}

export type AgentOverlayIndex = ReadonlyMap<string, AgentPresentation>

const HEX = /^#[0-9A-Fa-f]{6}$/

function isStops(value: unknown): value is readonly [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every((stop) => HEX.test(stop))
}

function parseBrandColor(value: unknown): AgentBrandColor | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { light, dark, gradient } = value as Record<string, unknown>
  if (typeof light !== 'string' || typeof dark !== 'string') return undefined
  if (!HEX.test(light) || !HEX.test(dark)) return undefined
  if (gradient === undefined) return { light, dark }
  const stops = gradient as Record<string, unknown> | null
  if (!stops || !isStops(stops.light) || !isStops(stops.dark)) return undefined
  return { light, dark, gradient: { light: stops.light, dark: stops.dark } }
}

/**
 * Validate an overlay's `overrides` (host reply or bundled file). An icon the
 * sanitizer refuses is dropped, the rest of its entry stays. The first entry
 * of a repeated id wins.
 */
export function indexAgentOverlay(overrides: unknown): AgentOverlayIndex {
  const index = new Map<string, AgentPresentation>()
  if (!Array.isArray(overrides)) return index
  for (const raw of overrides as Partial<AcpAgentOverride>[]) {
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0 || index.has(raw.id)) continue
    const presentation: AgentPresentation = {}
    if (typeof raw.name === 'string' && raw.name.trim().length > 0) {
      presentation.name = raw.name.trim()
    }
    if (typeof raw.icon === 'string') {
      const icon = sanitizeInlineAgentSvg(raw.icon)
      if (icon) {
        presentation.icon = icon
      } else {
        void logFrontendError({
          level: 'warn',
          source: 'agent-overlay',
          message: `Overlay icon for ${raw.id} rejected by the SVG sanitizer`
        })
      }
    }
    const brandColor = parseBrandColor(raw.brandColor)
    if (brandColor) presentation.brandColor = brandColor
    index.set(raw.id, presentation)
  }
  return index
}

let current: AgentOverlayIndex = indexAgentOverlay(bundledOverlay.overrides)
const listeners = new Set<() => void>()

export function getAgentOverlay(): AgentOverlayIndex {
  return current
}

export function subscribeAgentOverlay(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setAgentOverlay(overrides: unknown): void {
  current = indexAgentOverlay(overrides)
  for (const listener of listeners) listener()
}

/**
 * Replace the seed with the host's overlay. A failure keeps what is shown.
 * Resolves `true` when the host answered.
 */
export async function loadAgentOverlay(): Promise<boolean> {
  try {
    const overlay = await getAcpTransport().getAgentOverlay()
    setAgentOverlay(overlay.overrides)
    void logFrontendError({
      level: 'info',
      source: 'agent-overlay',
      message: `Agent overlay loaded source=${overlay.source} overrides=${overlay.overrides.length}`
    })
    return true
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: 'agent-overlay',
      message: `Agent overlay load failed: ${err instanceof Error ? err.message : String(err)}`
    })
    return false
  }
}
