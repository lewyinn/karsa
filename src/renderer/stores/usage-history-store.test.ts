import { beforeEach, describe, expect, it } from 'vitest'
import { FALLBACK_MODEL_PRICING } from '@/lib/model-pricing'
import {
  aggregateDailyUsage,
  aggregateProjectUsage,
  computeUsageTotals,
  useUsageHistoryStore
} from './usage-history-store'

beforeEach(() => {
  useUsageHistoryStore.getState().clearHistory()
})

describe('usage-history-store', () => {
  it('deduplicates incremental updates per session using high-water mark and aggregates daily/project rollups', () => {
    const now = new Date('2026-11-26T12:00:00Z').getTime()
    const store = useUsageHistoryStore.getState()

    store.recordSample({
      sessionId: 's1',
      title: 'Fix auth bug',
      projectId: 'p1',
      projectName: 'internity',
      agentName: 'Antigravity',
      modelId: 'gemini-2.5-pro',
      tokensUsed: 10_000,
      contextSize: 1_000_000,
      now
    })
    // Second incremental update on the same session should replace (not add) tokensUsed
    store.recordSample({
      sessionId: 's1',
      title: 'Fix auth bug',
      projectId: 'p1',
      projectName: 'internity',
      agentName: 'Antigravity',
      modelId: 'gemini-2.5-pro',
      tokensUsed: 25_000,
      contextSize: 1_000_000,
      now: now + 5_000
    })
    store.recordSample({
      sessionId: 's2',
      title: 'Refactor UI',
      projectId: 'p2',
      projectName: 'Karsa',
      agentName: 'Claude Code',
      modelId: 'claude-sonnet-4',
      tokensUsed: 40_000,
      contextSize: 200_000,
      reportedCostUsd: 0.42,
      now: now - 24 * 60 * 60 * 1000
    })

    const sessions = Object.values(useUsageHistoryStore.getState().sessions)
    expect(sessions).toHaveLength(2)

    const totals = computeUsageTotals(sessions, FALLBACK_MODEL_PRICING, '7d', now)
    expect(totals.tokens).toBe(65_000)
    expect(totals.sessions).toBe(2)
    expect(totals.hasEstimated).toBe(true)
    expect(totals.costUsd).toBeGreaterThan(0.42)
    expect(totals.topProjectName).toBe('Karsa')

    const daily = aggregateDailyUsage(sessions, FALLBACK_MODEL_PRICING, '7d', now)
    expect(daily).toHaveLength(7)

    const projects = aggregateProjectUsage(sessions, FALLBACK_MODEL_PRICING, '7d', now)
    expect(projects.map((p) => p.projectName)).toEqual(['Karsa', 'internity'])
  })
})
