import type { AgentBrandColor } from '@shared/types/acp-catalog.types'
import { type CSSProperties, useSyncExternalStore } from 'react'
/**
 * Icon catalog for agent glyphs and the custom-agent icon picker.
 *
 * Bundled icons are offline SVG using `currentColor`, sourced from:
 * 1. ACP Registry (acp/*.svg, frozen bundled snapshot)
 * 2. Generic category icons (terminal, dev, robot, sparkles, code, brain, zap)
 *
 * Karsa's registry overlay (`agent-overlay.ts`) goes first: its logo, name
 * and brand colour replace the bundled ones, and it can add a logo for an
 * agent the bundle has none for. The catalog is rebuilt when the overlay
 * changes, so read it through `useAgentIconCatalog` in components.
 */

import acpManifest from '@/assets/agent-icons/acp/manifest.json'
import brainIcon from '@/assets/agent-icons/brain.svg?raw'
import codeIcon from '@/assets/agent-icons/code.svg?raw'
import devIcon from '@/assets/agent-icons/dev.svg?raw'
import robotIcon from '@/assets/agent-icons/robot.svg?raw'
import sparklesIcon from '@/assets/agent-icons/sparkles.svg?raw'
// Generic icons — hand-bundled category symbols
import terminalIcon from '@/assets/agent-icons/terminal.svg?raw'
import zapIcon from '@/assets/agent-icons/zap.svg?raw'
import {
  type AgentOverlayIndex,
  getAgentOverlay,
  subscribeAgentOverlay
} from '@/lib/agents/agent-overlay'

// ACP icons — loaded via Vite's import.meta.glob
const acpSvgModules = import.meta.glob<string>('@/assets/agent-icons/acp/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default'
})

export interface BundledIconEntry {
  key: string
  label: string
  svg: string
  /** Set only when `svg` is single-colour (`currentColor`). */
  brandColor?: AgentBrandColor
}

export { normalizeRootIconSvg as normalizeIconSvg } from '@/lib/agents/sanitize-agent-icon'

/**
 * A full-colour logo keeps its own fills; only a `currentColor` one takes a
 * brand colour.
 */
function isSingleColour(svg: string): boolean {
  return /currentColor/i.test(svg)
}

interface BundledAcpIcon {
  id: string
  name: string
  svg: string
}

/** Manifest entries joined with their glob-loaded SVG. */
const BUNDLED_ACP_ICONS: readonly BundledAcpIcon[] = acpManifest.flatMap((entry) => {
  // import.meta.glob keys are like /src/renderer/assets/agent-icons/acp/claude-acp.svg
  const moduleKey = Object.keys(acpSvgModules).find((k) => k.endsWith(`/acp/${entry.file}`))
  const svg = moduleKey ? acpSvgModules[moduleKey] : undefined
  return svg ? [{ id: entry.id, name: entry.name, svg }] : []
})

const GENERIC_ICONS: readonly BundledIconEntry[] = [
  { key: 'generic:terminal', label: 'Terminal', svg: terminalIcon as string },
  { key: 'generic:dev', label: 'Developer', svg: devIcon as string },
  { key: 'generic:robot', label: 'Robot', svg: robotIcon as string },
  { key: 'generic:sparkles', label: 'Sparkles', svg: sparklesIcon as string },
  { key: 'generic:code', label: 'Code', svg: codeIcon as string },
  { key: 'generic:brain', label: 'Brain', svg: brainIcon as string },
  { key: 'generic:zap', label: 'Zap', svg: zapIcon as string }
] as const

export interface AgentIconCatalog {
  /** Picker order: ACP agents, then the generic category icons. */
  entries: readonly BundledIconEntry[]
  /** By catalog key, e.g. `acp:gemini`. */
  byKey(key: string): BundledIconEntry | undefined
  /** By stored SVG. A bundled logo the overlay replaced still resolves. */
  bySvg(svg: string): BundledIconEntry | undefined
  /**
   * The brand colour for a glyph. A persisted icon is coloured only when it
   * IS a catalog icon (an uploaded one keeps `currentColor`).
   */
  brandColor(
    icon: string | null | undefined,
    templateId: string | null | undefined
  ): AgentBrandColor | null
}

function acpEntry(id: string, label: string, svg: string, brand?: AgentBrandColor) {
  const entry: BundledIconEntry = { key: `acp:${id}`, label, svg }
  if (brand && isSingleColour(svg)) entry.brandColor = brand
  return entry
}

export function buildAgentIconCatalog(overlay: AgentOverlayIndex): AgentIconCatalog {
  const bySvg = new Map<string, BundledIconEntry>()
  const acp: BundledIconEntry[] = []
  for (const bundled of BUNDLED_ACP_ICONS) {
    const own = overlay.get(bundled.id)
    const entry = acpEntry(
      bundled.id,
      own?.name ?? bundled.name,
      own?.icon ?? bundled.svg,
      own?.brandColor
    )
    acp.push(entry)
    bySvg.set(entry.svg, entry)
    if (!bySvg.has(bundled.svg)) bySvg.set(bundled.svg, entry)
  }
  const bundledIds = new Set(BUNDLED_ACP_ICONS.map((icon) => icon.id))
  for (const [id, own] of overlay) {
    if (bundledIds.has(id) || !own.icon) continue
    const entry = acpEntry(id, own.name ?? id, own.icon, own.brandColor)
    acp.push(entry)
    bySvg.set(entry.svg, entry)
  }
  const entries = [...acp, ...GENERIC_ICONS]
  for (const entry of GENERIC_ICONS) bySvg.set(entry.svg, entry)
  const byKey = new Map(entries.map((entry) => [entry.key, entry]))
  return {
    entries,
    byKey: (key) => byKey.get(key),
    bySvg: (svg) => bySvg.get(svg),
    brandColor(icon, templateId) {
      if (icon) return bySvg.get(icon)?.brandColor ?? null
      if (!templateId) return null
      return byKey.get(`acp:${templateId}`)?.brandColor ?? null
    }
  }
}

let built: { overlay: AgentOverlayIndex; catalog: AgentIconCatalog } | null = null

/** The catalog for the overlay in use. Same object until the overlay changes. */
export function getAgentIconCatalog(): AgentIconCatalog {
  const overlay = getAgentOverlay()
  if (built?.overlay !== overlay) built = { overlay, catalog: buildAgentIconCatalog(overlay) }
  return built.catalog
}

/** {@link getAgentIconCatalog}, re-rendering when the overlay changes. */
export function useAgentIconCatalog(): AgentIconCatalog {
  return useSyncExternalStore(subscribeAgentOverlay, getAgentIconCatalog)
}

/**
 * Colours a glyph with its brand, per theme: the root `.dark` class (set by the
 * colour theme) picks `dark`, otherwise `light`. Merge `className` LAST with
 * `cn` so it replaces a caller's text colour. A gradient brand also fills the
 * icon's paths from the `<linearGradient>` that `withBrandGradient` adds.
 */
const BRAND_TEXT = 'text-(--agent-brand-light) [.dark_&]:text-(--agent-brand-dark)'
const BRAND_GRADIENT =
  '[--agent-brand-from:var(--agent-brand-from-light)] [--agent-brand-to:var(--agent-brand-to-light)] [.dark_&]:[--agent-brand-from:var(--agent-brand-from-dark)] [.dark_&]:[--agent-brand-to:var(--agent-brand-to-dark)] [&_path]:fill-(--agent-brand-fill)'

export function agentBrandProps(
  brand: AgentBrandColor,
  gradientId: string
): { className: string; style: CSSProperties } {
  const style: Record<string, string> = {
    '--agent-brand-light': brand.light,
    '--agent-brand-dark': brand.dark
  }
  if (!brand.gradient) return { className: BRAND_TEXT, style }
  const { light, dark } = brand.gradient
  Object.assign(style, {
    '--agent-brand-from-light': light[0],
    '--agent-brand-to-light': light[1],
    '--agent-brand-from-dark': dark[0],
    '--agent-brand-to-dark': dark[1],
    '--agent-brand-fill': `url(#${gradientId})`
  })
  return { className: `${BRAND_TEXT} ${BRAND_GRADIENT}`, style }
}

/** A DOM id usable inside `url(#…)`: React's `useId` output minus punctuation. */
export function brandGradientId(reactId: string): string {
  return `agent-brand-${reactId.replace(/[^A-Za-z0-9_-]/g, '')}`
}

/**
 * Adds the brand gradient (`id` unique per glyph instance) to a sanitized
 * icon. Stops read the theme-picked colours set by `agentBrandProps`.
 */
export function withBrandGradient(svg: string, brand: AgentBrandColor | null, id: string): string {
  if (!brand?.gradient) return svg
  const defs =
    `<defs><linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0">` +
    '<stop offset="0" style="stop-color:var(--agent-brand-from)"></stop>' +
    '<stop offset="1" style="stop-color:var(--agent-brand-to)"></stop>' +
    '</linearGradient></defs>'
  return svg.replace(/<svg\b[^>]*>/, (open) => `${open}${defs}`)
}
