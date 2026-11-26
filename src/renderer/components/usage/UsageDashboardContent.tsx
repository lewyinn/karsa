import type {
  AntigravityAccountsSnapshot,
  AntigravityAccountUsage
} from '@shared/types/antigravity-accounts.types'
import type {
  ClaudeAccountsSnapshot,
  ClaudeAccountUsage,
  ClaudeUsageWindow
} from '@shared/types/claude-accounts.types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { BarChart3, RefreshCw, Trash2 } from '@/components/icons'
import { AntigravityUsageMeters } from '@/components/settings/provider/AntigravityUsageMeters'
import { PERCENT_TEXT, UsageBar } from '@/components/settings/provider/account-status'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { antigravityAccountsApi } from '@/lib/antigravity-accounts-api'
import { formatUsageReset, usageTone } from '@/lib/antigravity-usage-format'
import { claudeAccountsApi } from '@/lib/claude-accounts-api'
import { logFrontendError } from '@/lib/log-api'
import { formatCompactTokens, formatUsd } from '@/lib/model-pricing'
import { cn } from '@/lib/utils'
import {
  aggregateDailyUsage,
  aggregateProjectUsage,
  computeUsageTotals,
  effectiveSessionCost,
  filterSessionsByRange,
  type UsageRange,
  useUsageHistoryStore
} from '@/stores/usage-history-store'

interface LiveQuotasState {
  loading: boolean
  claudeAccounts: ClaudeAccountsSnapshot['accounts']
  claudeUsage: ClaudeAccountUsage[]
  antigravityAccounts: AntigravityAccountsSnapshot['accounts']
  antigravityUsage: AntigravityAccountUsage[]
}

function claudeWindowLabel(window: ClaudeUsageWindow): string {
  if (window.scope) return window.scope
  if (window.kind === 'session' || window.group === 'session') return '5-hour window'
  if (window.kind.startsWith('weekly') || window.group === 'weekly') return 'Weekly window'
  return window.kind
}

function formatRelativeTime(ts: number): string {
  const diffMin = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return `${Math.round(diffHr / 24)}d ago`
}

export function UsageDashboardContent({ wide = false }: { wide?: boolean }): React.JSX.Element {
  const sessionsMap = useUsageHistoryStore((state) => state.sessions)
  const pricing = useUsageHistoryStore((state) => state.pricing)
  const loadingPricing = useUsageHistoryStore((state) => state.loadingPricing)

  const [range, setRange] = useState<UsageRange>('7d')
  const [chartMetric, setChartMetric] = useState<'tokens' | 'cost'>('cost')
  const [listTab, setListTab] = useState<'sessions' | 'projects'>('sessions')
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)
  const [quotas, setQuotas] = useState<LiveQuotasState>({
    loading: false,
    claudeAccounts: [],
    claudeUsage: [],
    antigravityAccounts: [],
    antigravityUsage: []
  })

  const refreshQuotas = useCallback(async (force = false) => {
    setQuotas((prev) => ({ ...prev, loading: true }))
    try {
      const [claudeList, claudeUsage, agList, agUsage] = await Promise.all([
        claudeAccountsApi.list().catch(() => null),
        claudeAccountsApi.usage(force).catch(() => []),
        antigravityAccountsApi.list().catch(() => null),
        antigravityAccountsApi.usage(force).catch(() => [])
      ])
      setQuotas({
        loading: false,
        claudeAccounts: claudeList?.accounts ?? [],
        claudeUsage,
        antigravityAccounts: agList?.accounts ?? [],
        antigravityUsage: agUsage
      })
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'UsageDashboardContent',
        message: `Failed to load live quotas: ${String(err)}`
      })
      setQuotas((prev) => ({ ...prev, loading: false }))
    }
  }, [])

  useEffect(() => {
    void useUsageHistoryStore.getState().refreshPricing(false)
    void refreshQuotas(false)
  }, [refreshQuotas])

  const allSessions = useMemo(
    () => Object.values(sessionsMap).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessionsMap]
  )
  const filteredSessions = useMemo(
    () => filterSessionsByRange(allSessions, range),
    [allSessions, range]
  )
  const totals = useMemo(
    () => computeUsageTotals(allSessions, pricing.models, range),
    [allSessions, pricing.models, range]
  )
  const dailyData = useMemo(
    () => aggregateDailyUsage(allSessions, pricing.models, range),
    [allSessions, pricing.models, range]
  )
  const projectRows = useMemo(
    () => aggregateProjectUsage(allSessions, pricing.models, range),
    [allSessions, pricing.models, range]
  )

  const claudeUsageById = useMemo(
    () => new Map(quotas.claudeUsage.map((u) => [u.accountId, u])),
    [quotas.claudeUsage]
  )
  const agUsageById = useMemo(
    () => new Map(quotas.antigravityUsage.map((u) => [u.accountId, u])),
    [quotas.antigravityUsage]
  )

  const hasAnyQuotaSection =
    quotas.claudeAccounts.length > 0 || quotas.antigravityAccounts.length > 0

  return (
    <div className={cn('space-y-3', wide ? 'p-4' : 'p-3')}>
      {/* Live Account Quotas */}
      <section className="rounded-lg border border-border bg-card p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-semibold text-foreground">Live Account Quotas</h3>
            <p className="text-3xs text-muted-foreground">
              Claude (5h / weekly) &amp; Antigravity plan limits
            </p>
          </div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={quotas.loading}
            onClick={() => void refreshQuotas(true)}
            className="gap-1"
          >
            <RefreshCw size={11} className={cn(quotas.loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {quotas.loading && !hasAnyQuotaSection ? (
          <div className="flex items-center gap-2 py-3 text-2xs text-muted-foreground">
            <Spinner size={12} decorative />
            Loading account quotas…
          </div>
        ) : !hasAnyQuotaSection ? (
          <p className="py-2 text-2xs text-muted-foreground">
            Connect a Claude or Antigravity account in Settings → Accounts to monitor live quota
            windows here.
          </p>
        ) : (
          <div className={cn('grid gap-3', wide ? 'grid-cols-2' : 'grid-cols-1')}>
            {quotas.claudeAccounts.map((acc) => {
              const usage = claudeUsageById.get(acc.id)
              return (
                <div key={`claude-${acc.id}`} className="rounded-md border border-border/70 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between gap-1.5">
                    <span className="truncate text-2xs font-medium text-foreground">
                      Claude · {acc.name}
                    </span>
                    {usage?.subscriptionType && (
                      <span className="rounded bg-muted px-1.5 py-px font-mono text-3xs uppercase text-secondary-foreground">
                        {usage.subscriptionType}
                      </span>
                    )}
                  </div>
                  {usage && usage.windows.length > 0 ? (
                    <div className="space-y-2">
                      {usage.windows.map((win) => {
                        const label = claudeWindowLabel(win)
                        const reset = formatUsageReset(win.resetsAt)
                        const tone = usageTone(win.percent)
                        return (
                          <div key={`${win.kind}-${win.scope ?? ''}`} className="space-y-1">
                            <div className="flex items-baseline gap-1.5 text-2xs">
                              <span className="truncate text-secondary-foreground">{label}</span>
                              <span
                                className={cn(
                                  'ml-auto shrink-0 font-semibold tabular-nums',
                                  PERCENT_TEXT[tone]
                                )}
                              >
                                {Math.round(win.percent)}%
                              </span>
                              {reset && (
                                <span className="shrink-0 text-3xs text-muted-foreground">
                                  {reset}
                                </span>
                              )}
                            </div>
                            <UsageBar
                              window={win}
                              label={`${label} usage`}
                              valueText={`${Math.round(win.percent)}% used`}
                            />
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-3xs text-muted-foreground">
                      {usage?.message || 'Quota data not available yet.'}
                    </p>
                  )}
                </div>
              )
            })}

            {quotas.antigravityAccounts.map((acc) => {
              const usage = agUsageById.get(acc.id)
              return (
                <div key={`ag-${acc.id}`} className="rounded-md border border-border/70 p-2.5">
                  <div className="mb-1 flex items-center justify-between gap-1.5">
                    <span className="truncate text-2xs font-medium text-foreground">
                      Antigravity · {acc.name}
                    </span>
                    {usage?.planType && (
                      <span className="rounded bg-muted px-1.5 py-px font-mono text-3xs text-secondary-foreground">
                        {usage.planType}
                      </span>
                    )}
                  </div>
                  {usage && usage.windows.length > 0 ? (
                    <AntigravityUsageMeters windows={usage.windows} />
                  ) : (
                    <p className="text-3xs text-muted-foreground">
                      {usage?.message || 'Run a usage check in Settings → Accounts or send a chat.'}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Range + Pricing Source Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
          {(['7d', '30d', 'all'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setRange(opt)}
              className={cn(
                'rounded px-2 py-0.5 text-2xs font-medium transition-colors',
                range === opt
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {opt === 'all' ? 'All' : opt.toUpperCase()}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => void useUsageHistoryStore.getState().refreshPricing(true)}
          disabled={loadingPricing}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Refresh live model token rates from OpenRouter"
        >
          <RefreshCw size={10} className={cn(loadingPricing && 'animate-spin')} />
          {pricing.source === 'live' ? 'Live pricing (OpenRouter)' : 'Fallback pricing'}
        </button>
      </div>

      {/* KPI Summary Cards */}
      <div className={cn('grid gap-2', wide ? 'grid-cols-4' : 'grid-cols-2')}>
        <div className="rounded-lg border border-border bg-card p-2.5">
          <div className="text-3xs text-muted-foreground">Total Tokens</div>
          <div
            data-testid="usage-total-tokens"
            className="mt-0.5 font-mono text-sm font-semibold text-foreground"
          >
            {formatCompactTokens(totals.tokens)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-2.5">
          <div className="text-3xs text-muted-foreground">
            {totals.hasEstimated ? 'Est. Cost (USD)' : 'Total Cost (USD)'}
          </div>
          <div
            data-testid="usage-total-cost"
            className="mt-0.5 font-mono text-sm font-semibold text-foreground"
          >
            {formatUsd(totals.costUsd, totals.hasEstimated)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-2.5">
          <div className="text-3xs text-muted-foreground">Sessions</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-foreground">
            {totals.sessions}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-2.5">
          <div className="text-3xs text-muted-foreground">Top Project</div>
          <div className="mt-0.5 truncate text-xs font-semibold text-foreground">
            {totals.topProjectName ?? '—'}
          </div>
        </div>
      </div>

      {/* Daily Chart */}
      <section className="rounded-lg border border-border bg-card p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">Daily Usage</h3>
          <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => setChartMetric('cost')}
              className={cn(
                'rounded px-2 py-0.5 text-3xs font-medium transition-colors',
                chartMetric === 'cost'
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Cost ($)
            </button>
            <button
              type="button"
              onClick={() => setChartMetric('tokens')}
              className={cn(
                'rounded px-2 py-0.5 text-3xs font-medium transition-colors',
                chartMetric === 'tokens'
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Tokens
            </button>
          </div>
        </div>

        {dailyData.length === 0 || totals.tokens === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1.5 py-6 text-center">
            <BarChart3 size={20} className="text-muted-foreground/45" />
            <p className="text-2xs text-muted-foreground">
              Send a message in Agent Chat to start recording token &amp; cost charts.
            </p>
          </div>
        ) : (
          <div className={cn('w-full', wide ? 'h-52' : 'h-36')}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyData} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) =>
                    chartMetric === 'cost' ? `$${v.toFixed(2)}` : formatCompactTokens(v)
                  }
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--popover)',
                    borderColor: 'var(--border)',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: 'var(--popover-foreground)'
                  }}
                  formatter={(value: unknown) => {
                    const num = typeof value === 'number' ? value : Number(value ?? 0)
                    return chartMetric === 'cost'
                      ? [formatUsd(num, true), 'Est. Cost']
                      : [formatCompactTokens(num), 'Tokens']
                  }}
                />
                <Bar
                  dataKey={chartMetric === 'cost' ? 'costUsd' : 'tokens'}
                  fill="var(--primary)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* Detailed Breakdown List */}
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => setListTab('sessions')}
              className={cn(
                'rounded px-2 py-0.5 text-2xs font-medium transition-colors',
                listTab === 'sessions'
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Sessions ({filteredSessions.length})
            </button>
            <button
              type="button"
              onClick={() => setListTab('projects')}
              className={cn(
                'rounded px-2 py-0.5 text-2xs font-medium transition-colors',
                listTab === 'projects'
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Projects ({projectRows.length})
            </button>
          </div>

          {allSessions.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClearOpen(true)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title="Clear recorded usage history"
            >
              <Trash2 size={11} />
              Clear
            </button>
          )}
        </div>

        <div
          className={cn(
            'scroller-thin divide-y divide-border/50 overflow-y-auto',
            wide ? 'max-h-72' : 'max-h-60'
          )}
        >
          {listTab === 'sessions' ? (
            filteredSessions.length === 0 ? (
              <div className="px-3 py-6 text-center text-2xs text-muted-foreground">
                No sessions recorded in this period yet.
              </div>
            ) : (
              filteredSessions.map((session) => {
                const { costUsd, estimated } = effectiveSessionCost(session, pricing.models)
                return (
                  <div
                    key={session.sessionId}
                    data-testid={`usage-session-${session.sessionId}`}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-foreground">
                        {session.title}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-3xs text-muted-foreground">
                        <span className="rounded bg-muted px-1 py-px font-mono text-secondary-foreground">
                          {session.projectName}
                        </span>
                        <span className="truncate">{session.modelId ?? session.agentName}</span>
                        <span>· {formatRelativeTime(session.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="shrink-0 text-right font-mono">
                      <div className="text-2xs font-semibold text-foreground">
                        {formatUsd(costUsd, estimated)}
                      </div>
                      <div className="text-3xs text-muted-foreground">
                        {formatCompactTokens(session.tokensUsed)} tok
                      </div>
                    </div>
                  </div>
                )
              })
            )
          ) : projectRows.length === 0 ? (
            <div className="px-3 py-6 text-center text-2xs text-muted-foreground">
              No project usage recorded yet.
            </div>
          ) : (
            projectRows.map((row) => (
              <div
                key={row.projectId}
                data-testid={`usage-project-${row.projectName}`}
                className="flex items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {row.projectName}
                  </div>
                  <div className="text-3xs text-muted-foreground">
                    {row.sessions} {row.sessions === 1 ? 'session' : 'sessions'}
                  </div>
                </div>
                <div className="shrink-0 text-right font-mono">
                  <div className="text-2xs font-semibold text-foreground">
                    {formatUsd(row.costUsd, row.estimatedCount > 0)}
                  </div>
                  <div className="text-3xs text-muted-foreground">
                    {formatCompactTokens(row.tokens)} tok
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <ConfirmDialog
        isOpen={confirmClearOpen}
        title="Clear usage history?"
        message="This resets your locally recorded token and estimated cost history. Live account quotas are unaffected."
        confirmLabel="Clear history"
        variant="danger"
        onConfirm={() => {
          useUsageHistoryStore.getState().clearHistory()
          setConfirmClearOpen(false)
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />
    </div>
  )
}
