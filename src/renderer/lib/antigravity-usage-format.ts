/**
 * Display helpers for Antigravity Account usage. Antigravity reports one quota
 * per model, so an Account's room is the room of its most used model. Tone,
 * reset time and the usage bar come from the shared helpers the Claude and
 * Codex rows already use.
 */

import type {
  AntigravityAccountUsage,
  AntigravityUsageWindow
} from '@shared/types/antigravity-accounts.types'
import type { ClaudeUsageWindow } from '@shared/types/claude-accounts.types'
import {
  formatUsageChecked,
  formatUsageReset,
  type UsageReading,
  type UsageTone,
  usageTone
} from '@/lib/claude-usage-format'

export type { UsageReading, UsageTone }
export { formatUsageChecked, formatUsageReset, usageTone }

export const ANTIGRAVITY_USAGE_WARNING_PERCENT = 80

/** The model/window name of a quota bar, stripping misleading "Remaining" suffixes since the meter shows % used (0% -> 100%). */
export function antigravityWindowLabel(window: AntigravityUsageWindow): string {
  const raw = window.label || window.modelId
  return raw.replace(/\s+remaining\s*$/i, '').trim()
}

/** Unix seconds of a window reset, for the live limit record. */
export function antigravityResetSeconds(
  window: AntigravityUsageWindow | null | undefined
): number | null {
  if (!window?.resetsAt) return null
  const at = Date.parse(window.resetsAt)
  return Number.isNaN(at) ? null : Math.floor(at / 1000)
}

/** A window whose reset time is still ahead. A missing time stays usable. */
export function antigravityWindowOpen(window: AntigravityUsageWindow, now = Date.now()): boolean {
  const resetAt = antigravityResetSeconds(window)
  return resetAt === null || resetAt * 1000 > now
}

/**
 * The window that sets the Account's room: the most used model that has not
 * reset. `null` when the read failed or reported no model.
 */
export function primaryAntigravityWindow(
  usage: AntigravityAccountUsage | undefined,
  now = Date.now()
): AntigravityUsageWindow | null {
  if (usage?.status !== 'ok') return null
  return usage.windows.reduce<AntigravityUsageWindow | null>((top, window) => {
    if (!antigravityWindowOpen(window, now)) return top
    return !top || window.percent > top.percent ? window : top
  }, null)
}

/** Shape the shared usage bar accepts. */
export function antigravityBarWindow(window: AntigravityUsageWindow): ClaudeUsageWindow {
  return {
    kind: 'model',
    group: null,
    scope: antigravityWindowLabel(window),
    percent: window.percent,
    resetsAt: window.resetsAt,
    severity: null
  }
}

/** The most used model, for the composer chip. */
export function antigravityChipUsage(usage: AntigravityAccountUsage | undefined): {
  main: UsageReading
  other: UsageReading | null
} | null {
  const window = primaryAntigravityWindow(usage)
  if (!window) return null
  const percent = Math.round(window.percent)
  const label = antigravityWindowLabel(window)
  return {
    main: { short: label, label, percent, tone: usageTone(percent) },
    other: null
  }
}

export function planLabel(planType: string | null): string | null {
  if (!planType) return null
  return planType.charAt(0).toUpperCase() + planType.slice(1)
}
