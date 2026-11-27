import { useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { BarChart3, RefreshCw, Trash2 } from '@/components/icons'
import { formatCompactTokens, formatUsd, type ModelTokenPricing } from '@/lib/model-pricing'
import { cn } from '@/lib/utils'
import {
  aggregateDailyProviderUsage,
  aggregateModelUsage,
  aggregateProjectUsage,
  aggregateProviderUsage,
  computeUsageTotals,
  type UsageProviderKey,
  type UsageRange,
  type UsageSessionRecord
} from '@/stores/usage-history-store'
import { PROVIDER_VISUALS, ProviderMark } from './usage-theme'

export type AnalyticsMetric = 'cost' | 'tokens'
type BreakdownMode = 'model' | 'day' | 'project'

interface UsageAnalyticsTabProps {
  metric: AnalyticsMetric
  wide: boolean
  range: UsageRange
  sessions: readonly UsageSessionRecord[]
  pricingModels: Record<string, ModelTokenPricing>
  pricingSource: 'live' | 'fallback'
  loadingPricing: boolean
  hasAnyHistory: boolean
  onRefreshPricing: () => void
  onRequestClear: () => void
}

const PROVIDER_ORDER: readonly UsageProviderKey[] = ['antigravity', 'claude', 'codex', 'other']

function formatSharePct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '0.0%'
  return `${pct.toFixed(1)}%`
}

export function UsageAnalyticsTab({
  metric,
  wide,
  range,
  sessions,
  pricingModels,
  pricingSource,
  loadingPricing,
  hasAnyHistory,
  onRefreshPricing,
  onRequestClear
}: UsageAnalyticsTabProps): React.JSX.Element {
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>('model')

  const totals = useMemo(
    () => computeUsageTotals(sessions, pricingModels, 'all'),
    [sessions, pricingModels]
  )
  const providers = useMemo(
    () => aggregateProviderUsage(sessions, pricingModels),
    [sessions, pricingModels]
  )
  const dailySeries = useMemo(
    () => aggregateDailyProviderUsage(sessions, pricingModels, range),
    [sessions, pricingModels, range]
  )
  const modelRows = useMemo(
    () => aggregateModelUsage(sessions, pricingModels, metric),
    [sessions, pricingModels, metric]
  )
  const projectRows = useMemo(
    () => aggregateProjectUsage(sessions, pricingModels, 'all'),
    [sessions, pricingModels]
  )

  const activeProviders = useMemo(() => {
    const present = new Set(providers.map((p) => p.provider))
    return PROVIDER_ORDER.filter((p) => present.has(p))
  }, [providers])

  const dayRows = useMemo(() => {
    return dailySeries
      .filter((d) => d.tokens > 0 || d.costUsd > 0)
      .slice()
      .sort((a, b) => (metric === 'cost' ? b.costUsd - a.costUsd : b.tokens - a.tokens))
  }, [dailySeries, metric])

  const avgTokensPerSession = totals.sessions > 0 ? Math.round(totals.tokens / totals.sessions) : 0

  if (sessions.length === 0 || totals.tokens === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
        <BarChart3 size={24} className="text-muted-foreground/45" />
        <p className="text-xs font-medium text-foreground">No usage recorded in this period</p>
        <p className="max-w-xs text-2xs text-muted-foreground">
          Send a message in Agent Chat to start tracking live token volume, model breakdown, and API
          cost estimates.
        </p>
      </div>
    )
  }

  return (
    <div className={cn('mx-auto w-full space-y-6', wide && 'max-w-4xl')}>
      {/* Hero Summary + Smooth Multi-Provider Area Chart */}
      <div className={cn('grid gap-6', wide ? 'grid-cols-12 items-start' : 'grid-cols-1')}>
        {/* Left Hero & Provider Breakdown */}
        <div className={cn('space-y-4', wide && 'col-span-4')}>
          <div>
            <div
              data-testid={metric === 'cost' ? 'usage-total-cost' : 'usage-total-tokens'}
              className={cn(
                'font-semibold tabular-nums tracking-tight text-foreground',
                wide ? 'text-3xl leading-tight' : 'text-2xl leading-tight'
              )}
            >
              {metric === 'cost'
                ? formatUsd(totals.costUsd, totals.hasEstimated)
                : formatCompactTokens(totals.tokens)}
            </div>
            <div className="mt-0.5 text-2xs text-muted-foreground">
              {totals.sessions} {totals.sessions === 1 ? 'session' : 'sessions'}
              {metric === 'cost' && totals.hasEstimated ? ' · API estimate' : ''}
            </div>
          </div>

          <div className="space-y-2.5">
            {providers.map((row) => {
              const visual = PROVIDER_VISUALS[row.provider]
              const primaryValue =
                metric === 'cost'
                  ? formatUsd(row.costUsd, totals.hasEstimated)
                  : formatCompactTokens(row.tokens)
              const secondaryLine =
                metric === 'cost'
                  ? `${formatSharePct(row.costShare)} of cost · ${formatCompactTokens(row.tokens)} tokens`
                  : `${formatSharePct(row.tokenShare)} of tokens · ${formatUsd(row.costUsd, totals.hasEstimated)}`
              return (
                <div key={row.provider} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: visual.stroke }}
                      />
                      <ProviderMark provider={row.provider} size={13} />
                      <span className="truncate font-medium text-foreground">{visual.label}</span>
                      <span className="shrink-0 text-3xs text-muted-foreground">
                        {row.sessions} {row.sessions === 1 ? 'session' : 'sessions'}
                      </span>
                    </div>
                    <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-foreground">
                      {primaryValue}
                    </span>
                  </div>
                  <div className="pl-3 text-3xs text-muted-foreground">{secondaryLine}</div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right Daily Smooth Area Chart */}
        <div className={cn('space-y-2', wide && 'col-span-8')}>
          <div className="text-xs font-medium text-secondary-foreground">
            {metric === 'cost' ? 'Daily cost' : 'Daily processed tokens'}
          </div>
          <div className={cn('w-full', wide ? 'h-52' : 'h-40')}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dailySeries} margin={{ top: 6, right: 6, left: -14, bottom: 0 }}>
                <defs>
                  {activeProviders.map((provider) => {
                    const visual = PROVIDER_VISUALS[provider]
                    return (
                      <linearGradient
                        key={provider}
                        id={`usage-grad-${metric}-${provider}`}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop offset="0%" stopColor={visual.stroke} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={visual.stroke} stopOpacity={0.02} />
                      </linearGradient>
                    )
                  })}
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="oklch(var(--border) / 0.65)"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: 'oklch(var(--muted-foreground))' }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'oklch(var(--muted-foreground))' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) =>
                    metric === 'cost'
                      ? v >= 1
                        ? `$${v.toFixed(0)}`
                        : `$${v.toFixed(2)}`
                      : formatCompactTokens(v)
                  }
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'oklch(var(--popover))',
                    borderColor: 'oklch(var(--border))',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: 'oklch(var(--popover-foreground))'
                  }}
                  itemStyle={{ color: 'oklch(var(--popover-foreground))' }}
                  labelStyle={{ color: 'oklch(var(--muted-foreground))', marginBottom: 4 }}
                  formatter={(value: unknown, name: unknown) => {
                    const num = typeof value === 'number' ? value : Number(value ?? 0)
                    const label = String(name ?? '')
                    return metric === 'cost'
                      ? [formatUsd(num, true), label]
                      : [formatCompactTokens(num), label]
                  }}
                />
                {activeProviders.map((provider) => {
                  const visual = PROVIDER_VISUALS[provider]
                  const dataKey = metric === 'cost' ? `${provider}Cost` : `${provider}Tokens`
                  return (
                    <Area
                      key={provider}
                      type="monotone"
                      dataKey={dataKey}
                      name={visual.label}
                      stroke={visual.stroke}
                      strokeWidth={1.75}
                      fill={`url(#usage-grad-${metric}-${provider})`}
                      dot={false}
                      activeDot={{ r: 3.5, strokeWidth: 0, fill: visual.stroke }}
                    />
                  )
                })}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Real-Data Totals Strip */}
      <section className="space-y-3 border-t border-border/60 pt-4">
        <h3 className="text-2xs font-medium text-secondary-foreground">Totals</h3>
        <div className={cn('grid gap-3', wide ? 'grid-cols-5' : 'grid-cols-2')}>
          <div>
            <div className="text-3xs text-muted-foreground">Processed tokens</div>
            <div
              data-testid={metric === 'cost' ? 'usage-total-tokens' : undefined}
              className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground"
            >
              {formatCompactTokens(totals.tokens)}
            </div>
          </div>
          <div>
            <div className="text-3xs text-muted-foreground">
              {totals.hasEstimated ? 'Est. API cost' : 'Total cost'}
            </div>
            <div
              data-testid={metric === 'tokens' ? 'usage-total-cost' : undefined}
              className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground"
            >
              {formatUsd(totals.costUsd, totals.hasEstimated)}
            </div>
          </div>
          <div>
            <div className="text-3xs text-muted-foreground">Sessions</div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
              {totals.sessions}
            </div>
          </div>
          <div>
            <div className="text-3xs text-muted-foreground">Avg / session</div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
              {formatCompactTokens(avgTokensPerSession)}
            </div>
          </div>
          <div>
            <div className="text-3xs text-muted-foreground">Active projects</div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
              {projectRows.length}
            </div>
          </div>
        </div>

        {/* Segmented Proportion Bar by Provider */}
        {providers.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <div className="text-3xs font-medium text-secondary-foreground">
              {metric === 'cost' ? 'Cost by provider' : 'Tokens by provider'}
            </div>
            <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted/60">
              {providers.map((row) => {
                const pct = metric === 'cost' ? row.costShare : row.tokenShare
                if (pct <= 0) return null
                return (
                  <div
                    key={row.provider}
                    style={{
                      width: `${Math.max(2, pct)}%`,
                      backgroundColor: PROVIDER_VISUALS[row.provider].stroke
                    }}
                    className="h-full first:rounded-l-full last:rounded-r-full"
                    title={`${PROVIDER_VISUALS[row.provider].label}: ${formatSharePct(pct)}`}
                  />
                )
              })}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-3xs text-muted-foreground">
              {providers.map((row) => {
                const visual = PROVIDER_VISUALS[row.provider]
                const val =
                  metric === 'cost'
                    ? formatUsd(row.costUsd, totals.hasEstimated)
                    : formatCompactTokens(row.tokens)
                return (
                  <span key={row.provider} className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-xs"
                      style={{ backgroundColor: visual.stroke }}
                    />
                    <span>{visual.label}</span>
                    <span className="font-mono font-medium text-foreground">{val}</span>
                  </span>
                )
              })}
            </div>
          </div>
        )}
      </section>

      {/* Ranked Breakdown Table (Model | Day | Project) */}
      <section className="space-y-2.5 border-t border-border/60 pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-2xs font-medium text-secondary-foreground">Breakdown</h3>
          <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
            {(['model', 'day', 'project'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setBreakdownMode(tab)}
                className={cn(
                  'rounded px-2 py-0.5 text-3xs font-medium capitalize transition-colors',
                  breakdownMode === tab
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border/50 text-3xs text-muted-foreground">
                <th className="w-7 py-1.5 font-normal">#</th>
                <th className="py-1.5 font-normal capitalize">{breakdownMode}</th>
                <th className="py-1.5 text-right font-normal">Cost</th>
                <th className="w-16 py-1.5 text-right font-normal">Share</th>
                <th className="w-20 py-1.5 text-right font-normal">Tokens</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 text-xs">
              {breakdownMode === 'model' &&
                modelRows.map((row, index) => {
                  const visual = PROVIDER_VISUALS[row.provider]
                  const share = metric === 'cost' ? row.costShare : row.tokenShare
                  return (
                    <tr
                      key={`${row.provider}:${row.modelId}`}
                      data-testid={`usage-model-${row.modelId}`}
                      className="transition-colors hover:bg-muted/25"
                    >
                      <td className="py-2.5 align-top font-mono text-3xs text-muted-foreground">
                        {index + 1}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-1.5">
                          <ProviderMark provider={row.provider} size={13} />
                          <span className="truncate font-mono text-2xs font-medium text-foreground">
                            {row.modelId}
                          </span>
                        </div>
                        <div className="mt-1.5 h-0.5 w-full max-w-56 overflow-hidden rounded-full bg-muted/50">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(4, Math.min(100, share))}%`,
                              backgroundColor: visual.miniBar
                            }}
                          />
                        </div>
                      </td>
                      <td className="py-2.5 text-right align-top font-mono text-2xs tabular-nums text-foreground">
                        {row.costUsd > 0 ? (
                          formatUsd(row.costUsd, totals.hasEstimated)
                        ) : (
                          <span className="text-muted-foreground">Unpriced</span>
                        )}
                      </td>
                      <td className="py-2.5 text-right align-top font-mono text-2xs tabular-nums text-muted-foreground">
                        {formatSharePct(share)}
                      </td>
                      <td className="py-2.5 text-right align-top font-mono text-2xs tabular-nums text-foreground">
                        {formatCompactTokens(row.tokens)}
                      </td>
                    </tr>
                  )
                })}

              {breakdownMode === 'day' &&
                dayRows.map((row, index) => {
                  const share =
                    metric === 'cost'
                      ? totals.costUsd > 0
                        ? (row.costUsd / totals.costUsd) * 100
                        : 0
                      : totals.tokens > 0
                        ? (row.tokens / totals.tokens) * 100
                        : 0
                  return (
                    <tr key={row.dayKey} className="transition-colors hover:bg-muted/25">
                      <td className="py-2.5 align-top font-mono text-3xs text-muted-foreground">
                        {index + 1}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="font-mono text-2xs font-medium text-foreground">
                          {row.label}
                          <span className="ml-2 font-sans text-3xs text-muted-foreground">
                            {row.sessions} {row.sessions === 1 ? 'session' : 'sessions'}
                          </span>
                        </div>
                        <div className="mt-1.5 h-0.5 w-full max-w-56 overflow-hidden rounded-full bg-muted/50">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(4, Math.min(100, share))}%`,
                              backgroundColor: 'oklch(var(--primary))'
                            }}
                          />
                        </div>
                      </td>
                      <td className="py-2.5 text-right align-top font-mono text-2xs tabular-nums text-foreground">
                        {formatUsd(row.costUsd, totals.hasEstimated)}
                      </td>
                      <td className="py-2.5 text-right align-top font-mono text-2xs tabular-nums text-muted-foreground">
                        {formatSharePct(share)}
                      </td>
                      <td className="py-2.5 text-right align-top font-mono text-2xs tabular-nums text-foreground">
                        {formatCompactTokens(row.tokens)}
                      </td>
                    </tr>
                  )
                })}

              {breakdownMode === 'project' &&
                projectRows.map((row, index) => {
                  const share =
                    metric === 'cost'
                      ? totals.costUsd > 0
                        ? (row.costUsd / totals.costUsd) * 100
                        : 0
                      : totals.tokens > 0
                        ? (row.tokens / totals.tokens) * 100
                        : 0
                  return (
                    <tr
                      key={row.projectId}
                      data-testid={`usage-project-${row.projectName}`}
                      className="transition-colors hover:bg-muted/25"
                    >
                      <td className="py-2.5 align-top font-mono text-3xs text-muted-foreground">
                        {index + 1}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="truncate text-2xs font-medium text-foreground">
                          {row.projectName}
                          <span className="ml-2 text-3xs text-muted-foreground">
                            {row.sessions} {row.sessions === 1 ? 'session' : 'sessions'}
                          </span>
                        </div>
                        <div className="mt-1.5 h-0.5 w-full max-w-56 overflow-hidden rounded-full bg-muted/50">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(4, Math.min(100, share))}%`,
                              backgroundColor: 'oklch(var(--primary))'
                            }}
                          />
                        </div>
                      </td>
                      <td className="py-2.5 text-right align-top font-mono text-2xs tabular-nums text-foreground">
                        {formatUsd(row.costUsd, row.estimatedCount > 0)}
                      </td>
                      <td className="py-2.5 text-right align-top font-mono text-2xs tabular-nums text-muted-foreground">
                        {formatSharePct(share)}
                      </td>
                      <td className="py-2.5 text-right align-top font-mono text-2xs tabular-nums text-foreground">
                        {formatCompactTokens(row.tokens)}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Quiet Footer: OpenRouter live pricing + Clear history */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3">
        <button
          type="button"
          onClick={onRefreshPricing}
          disabled={loadingPricing}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Refresh live model token rates from OpenRouter"
        >
          <RefreshCw size={10} className={cn(loadingPricing && 'animate-spin')} />
          {pricingSource === 'live' ? 'Live pricing (OpenRouter)' : 'Fallback pricing'}
        </button>

        {hasAnyHistory && (
          <button
            type="button"
            onClick={onRequestClear}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            title="Clear recorded usage history"
          >
            <Trash2 size={10} />
            Clear history
          </button>
        )}
      </div>
    </div>
  )
}
