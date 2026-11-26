import { create } from 'zustand'
import {
  estimateTokensCostUsd,
  fallbackPricingSnapshot,
  fetchLiveModelPricing,
  type ModelPricingSnapshot,
  type ModelTokenPricing,
  readCachedPricing
} from '@/lib/model-pricing'

export interface UsageSessionRecord {
  sessionId: string
  title: string
  projectId: string
  projectName: string
  agentName: string
  modelId: string | null
  tokensUsed: number
  contextSize: number
  /** Reported directly by the ACP agent when available; null if subscription/unreported. */
  reportedCostUsd: number | null
  dayKey: string
  updatedAt: number
}

export type UsageRange = '7d' | '30d' | 'all'

export interface DailyUsagePoint {
  dayKey: string
  label: string
  tokens: number
  costUsd: number
  sessions: number
}

export interface ProjectUsageRow {
  projectId: string
  projectName: string
  tokens: number
  costUsd: number
  estimatedCount: number
  sessions: number
}

export interface UsageTotals {
  tokens: number
  costUsd: number
  hasEstimated: boolean
  sessions: number
  topProjectName: string | null
}

const STORAGE_KEY = 'karsa:usage-history:v1'
const MAX_SESSIONS = 500

export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function readStoredSessions(): Record<string, UsageSessionRecord> {
  try {
    if (typeof window === 'undefined') return {}
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, UsageSessionRecord>)
      : {}
  } catch {
    return {}
  }
}

function writeStoredSessions(sessions: Record<string, UsageSessionRecord>): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
  } catch {
    // Ignore quota failures.
  }
}

function pruneSessions(
  sessions: Record<string, UsageSessionRecord>
): Record<string, UsageSessionRecord> {
  const entries = Object.values(sessions)
  if (entries.length <= MAX_SESSIONS) return sessions
  const sorted = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS)
  const next: Record<string, UsageSessionRecord> = {}
  for (const item of sorted) {
    next[item.sessionId] = item
  }
  return next
}

export function effectiveSessionCost(
  record: UsageSessionRecord,
  models: Record<string, ModelTokenPricing>
): { costUsd: number; estimated: boolean } {
  if (
    record.reportedCostUsd !== null &&
    Number.isFinite(record.reportedCostUsd) &&
    record.reportedCostUsd > 0
  ) {
    return { costUsd: record.reportedCostUsd, estimated: false }
  }
  return {
    costUsd: estimateTokensCostUsd(record.modelId, record.tokensUsed, models),
    estimated: true
  }
}

export function filterSessionsByRange(
  sessions: readonly UsageSessionRecord[],
  range: UsageRange,
  now = Date.now()
): UsageSessionRecord[] {
  if (range === 'all') return [...sessions]
  const days = range === '7d' ? 7 : 30
  const cutoff = now - days * 24 * 60 * 60 * 1000
  return sessions.filter((s) => s.updatedAt >= cutoff)
}

export function aggregateDailyUsage(
  sessions: readonly UsageSessionRecord[],
  models: Record<string, ModelTokenPricing>,
  range: UsageRange,
  now = Date.now()
): DailyUsagePoint[] {
  const filtered = filterSessionsByRange(sessions, range, now)
  const byDay = new Map<string, { tokens: number; costUsd: number; sessions: number }>()

  for (const item of filtered) {
    const cost = effectiveSessionCost(item, models).costUsd
    const bucket = byDay.get(item.dayKey) ?? { tokens: 0, costUsd: 0, sessions: 0 }
    bucket.tokens += item.tokensUsed
    bucket.costUsd += cost
    bucket.sessions += 1
    byDay.set(item.dayKey, bucket)
  }

  if (range === 'all') {
    const keys = [...byDay.keys()].sort()
    return keys.map((dayKey) => {
      const bucket = byDay.get(dayKey)!
      return {
        dayKey,
        label: dayKey.slice(5),
        tokens: bucket.tokens,
        costUsd: Number(bucket.costUsd.toFixed(4)),
        sessions: bucket.sessions
      }
    })
  }

  const days = range === '7d' ? 7 : 30
  const points: DailyUsagePoint[] = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const ts = now - i * 24 * 60 * 60 * 1000
    const dayKey = localDayKey(ts)
    const bucket = byDay.get(dayKey) ?? { tokens: 0, costUsd: 0, sessions: 0 }
    points.push({
      dayKey,
      label: dayKey.slice(5),
      tokens: bucket.tokens,
      costUsd: Number(bucket.costUsd.toFixed(4)),
      sessions: bucket.sessions
    })
  }
  return points
}

export function aggregateProjectUsage(
  sessions: readonly UsageSessionRecord[],
  models: Record<string, ModelTokenPricing>,
  range: UsageRange,
  now = Date.now()
): ProjectUsageRow[] {
  const filtered = filterSessionsByRange(sessions, range, now)
  const byProject = new Map<string, ProjectUsageRow>()

  for (const item of filtered) {
    const { costUsd, estimated } = effectiveSessionCost(item, models)
    const key = item.projectId || 'unassigned'
    const existing = byProject.get(key) ?? {
      projectId: key,
      projectName: item.projectName || 'Quick chats',
      tokens: 0,
      costUsd: 0,
      estimatedCount: 0,
      sessions: 0
    }
    existing.tokens += item.tokensUsed
    existing.costUsd += costUsd
    if (estimated) existing.estimatedCount += 1
    existing.sessions += 1
    byProject.set(key, existing)
  }

  return [...byProject.values()].sort((a, b) => b.tokens - a.tokens)
}

export function computeUsageTotals(
  sessions: readonly UsageSessionRecord[],
  models: Record<string, ModelTokenPricing>,
  range: UsageRange,
  now = Date.now()
): UsageTotals {
  const filtered = filterSessionsByRange(sessions, range, now)
  const projects = aggregateProjectUsage(filtered, models, 'all', now)
  let tokens = 0
  let costUsd = 0
  let hasEstimated = false

  for (const item of filtered) {
    const cost = effectiveSessionCost(item, models)
    tokens += item.tokensUsed
    costUsd += cost.costUsd
    if (cost.estimated) hasEstimated = true
  }

  return {
    tokens,
    costUsd,
    hasEstimated,
    sessions: filtered.length,
    topProjectName: projects[0]?.projectName ?? null
  }
}

export interface RecordUsageSampleInput {
  sessionId: string
  title?: string
  projectId?: string
  projectName?: string
  agentName?: string
  modelId?: string | null
  tokensUsed: number
  contextSize: number
  reportedCostUsd?: number | null
  now?: number
}

interface UsageHistoryState {
  sessions: Record<string, UsageSessionRecord>
  pricing: ModelPricingSnapshot
  loadingPricing: boolean

  recordSample: (input: RecordUsageSampleInput) => void
  refreshPricing: (force?: boolean) => Promise<void>
  clearHistory: () => void
}

export const useUsageHistoryStore = create<UsageHistoryState>((set) => ({
  sessions: readStoredSessions(),
  pricing: readCachedPricing() ?? fallbackPricingSnapshot(),
  loadingPricing: false,

  recordSample: (input) => {
    if (!input.sessionId || !Number.isFinite(input.tokensUsed) || input.tokensUsed <= 0) return
    const now = input.now ?? Date.now()
    set((state) => {
      const prev = state.sessions[input.sessionId]
      const nextTokens = prev ? Math.max(prev.tokensUsed, input.tokensUsed) : input.tokensUsed
      const nextReported =
        input.reportedCostUsd !== undefined &&
        input.reportedCostUsd !== null &&
        Number.isFinite(input.reportedCostUsd) &&
        input.reportedCostUsd > 0
          ? prev?.reportedCostUsd
            ? Math.max(prev.reportedCostUsd, input.reportedCostUsd)
            : input.reportedCostUsd
          : (prev?.reportedCostUsd ?? null)

      const nextRecord: UsageSessionRecord = {
        sessionId: input.sessionId,
        title: input.title?.trim() || prev?.title || 'Untitled chat',
        projectId: input.projectId || prev?.projectId || '',
        projectName: input.projectName?.trim() || prev?.projectName || 'Quick chats',
        agentName: input.agentName?.trim() || prev?.agentName || 'Agent',
        modelId: input.modelId ?? prev?.modelId ?? null,
        tokensUsed: nextTokens,
        contextSize: Math.max(input.contextSize, prev?.contextSize ?? 0),
        reportedCostUsd: nextReported,
        dayKey: prev?.dayKey || localDayKey(now),
        updatedAt: now
      }

      const nextSessions = pruneSessions({
        ...state.sessions,
        [input.sessionId]: nextRecord
      })
      writeStoredSessions(nextSessions)
      return { sessions: nextSessions }
    })
  },

  refreshPricing: async (force = false) => {
    set({ loadingPricing: true })
    try {
      const snapshot = await fetchLiveModelPricing(force)
      set({ pricing: snapshot, loadingPricing: false })
    } catch {
      set({ loadingPricing: false })
    }
  },

  clearHistory: () => {
    writeStoredSessions({})
    set({ sessions: {} })
  }
}))
