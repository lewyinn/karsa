import { useMemo } from 'react'
import { useAgentIconCatalog } from '@/lib/agents/agent-icon-catalog'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import type { UsageProviderKey } from '@/stores/usage-history-store'

export interface ProviderVisual {
  key: UsageProviderKey
  label: string
  shortLabel: string
  iconKey: string | null
  /** Chart curve stroke & dot color (high-contrast OKLCH). */
  stroke: string
  /** Thick Limits bar fill color (muted rich surface matching reference screenshots). */
  barFill: string
  /** Subtle bar fill for breakdown mini bars. */
  miniBar: string
}

export const PROVIDER_VISUALS: Record<UsageProviderKey, ProviderVisual> = {
  antigravity: {
    key: 'antigravity',
    label: 'Antigravity',
    shortLabel: 'Antigravity',
    iconKey: 'acp:antigravity-acp',
    stroke: 'oklch(0.67 0.14 276)',
    barFill: 'oklch(0.41 0.08 276)',
    miniBar: 'oklch(0.62 0.13 276)'
  },
  claude: {
    key: 'claude',
    label: 'Claude Code',
    shortLabel: 'Claude',
    iconKey: 'acp:claude-acp',
    stroke: 'oklch(0.68 0.14 42)',
    barFill: 'oklch(0.43 0.08 42)',
    miniBar: 'oklch(0.64 0.13 42)'
  },
  codex: {
    key: 'codex',
    label: 'Codex',
    shortLabel: 'Codex',
    iconKey: 'acp:codex-acp',
    stroke: 'oklch(var(--success))',
    barFill: 'oklch(var(--success) / 0.45)',
    miniBar: 'oklch(var(--success))'
  },
  other: {
    key: 'other',
    label: 'Other',
    shortLabel: 'Other',
    iconKey: null,
    stroke: 'oklch(var(--primary))',
    barFill: 'oklch(var(--primary) / 0.45)',
    miniBar: 'oklch(var(--primary))'
  }
}

export function ProviderMark({
  provider,
  size = 14
}: {
  provider: UsageProviderKey
  size?: number
}): React.JSX.Element {
  const visual = PROVIDER_VISUALS[provider]
  const catalog = useAgentIconCatalog()
  const svg = useMemo(() => {
    if (!visual.iconKey) return null
    const entry = catalog.byKey(visual.iconKey)
    return entry ? sanitizeInlineAgentSvg(entry.svg) : null
  }, [catalog, visual.iconKey])

  if (svg) {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size, color: visual.stroke }}
        className="inline-flex shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized bundled SVG
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      style={{
        width: Math.max(8, size - 4),
        height: Math.max(8, size - 4),
        backgroundColor: visual.stroke
      }}
      className="inline-block shrink-0 rounded-full"
    />
  )
}

/** Compact reset countdown matching `6d 20h` / `4h 59m` / `31m`. */
export function formatCompactReset(
  resetsAt: string | null | undefined,
  now = Date.now()
): string | null {
  if (!resetsAt) return null
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return null
  const diffMin = Math.max(0, Math.round((at - now) / 60_000))
  if (diffMin < 1) return '<1m'
  if (diffMin < 60) return `${diffMin}m`
  const hours = Math.floor(diffMin / 60)
  const mins = diffMin % 60
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
}

/**
 * Expected remaining fraction (0..100) based on time left until `resetsAt`.
 * Shown as the crisp vertical pace line inside each Limits progress bar.
 */
export function computePacePercent(
  resetsAt: string | null | undefined,
  label: string,
  kind: string,
  now = Date.now()
): number | null {
  if (!resetsAt) return null
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at) || at <= now) return null
  const lower = `${label} ${kind}`.toLowerCase()
  const durationMs =
    lower.includes('week') || lower.includes('7d')
      ? 7 * 24 * 60 * 60 * 1000
      : lower.includes('5') || lower.includes('five') || lower.includes('session')
        ? 5 * 60 * 60 * 1000
        : null
  if (!durationMs) return null
  const remainingFraction = (at - now) / durationMs
  if (remainingFraction <= 0.01 || remainingFraction >= 0.995) return null
  return Math.max(2, Math.min(98, remainingFraction * 100))
}

/** Shorten Antigravity verbose quota window names to match clean card labels. */
export function formatLimitWindowTitle(raw: string): string {
  const cleaned = raw.replace(/\s+remaining\s*$/i, '').trim()
  return cleaned
    .replace(/\bModels\s*·\s*/i, ' · ')
    .replace(/\bFive Hour Limit\b/i, '5-hour')
    .replace(/\bWeekly Limit\b/i, 'Weekly')
    .replace(/\bClaude and GPT models\b/i, 'Claude & GPT (shared)')
    .replace(/\s+·\s+/g, ' · ')
    .trim()
}
