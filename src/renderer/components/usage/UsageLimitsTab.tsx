import type {
  AntigravityAccountsSnapshot,
  AntigravityAccountUsage
} from '@shared/types/antigravity-accounts.types'
import type {
  ClaudeAccountsSnapshot,
  ClaudeAccountUsage,
  ClaudeUsageWindow
} from '@shared/types/claude-accounts.types'
import { RotateCcw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { UsageProviderKey } from '@/stores/usage-history-store'
import {
  computePacePercent,
  formatCompactReset,
  formatLimitWindowTitle,
  PROVIDER_VISUALS,
  ProviderMark
} from './usage-theme'

interface UsageLimitsTabProps {
  wide: boolean
  loading: boolean
  providerFilter: UsageProviderKey | 'all'
  claudeAccounts: ClaudeAccountsSnapshot['accounts']
  claudeUsageById: ReadonlyMap<string, ClaudeAccountUsage>
  antigravityAccounts: AntigravityAccountsSnapshot['accounts']
  antigravityUsageById: ReadonlyMap<string, AntigravityAccountUsage>
  onForceRefresh: () => void
}

function claudeWindowTitle(win: ClaudeUsageWindow): string {
  if (win.scope) return win.scope
  if (win.kind === 'session' || win.group === 'session') return 'Session'
  if (win.kind.startsWith('weekly') || win.group === 'weekly') return 'Weekly'
  return win.kind
}

const HATCHED_TRACK_STYLE: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(-45deg, transparent, transparent 4px, oklch(var(--foreground) / 0.05) 4px, oklch(var(--foreground) / 0.05) 6px)'
}

function LimitRowCard({
  provider,
  title,
  usedPercent,
  resetsAt,
  kind,
  wide
}: {
  provider: UsageProviderKey
  title: string
  usedPercent: number
  resetsAt: string | null | undefined
  kind: string
  wide: boolean
}): React.JSX.Element {
  const visual = PROVIDER_VISUALS[provider]
  const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - usedPercent)))
  const resetText = formatCompactReset(resetsAt)
  const pacePct = computePacePercent(resetsAt, title, kind)

  return (
    <div
      className={cn(
        'rounded-xl border border-border/60 bg-card/45 px-4 py-3 transition-colors hover:border-border',
        wide ? 'flex items-center gap-6' : 'space-y-2 px-3 py-2.5'
      )}
    >
      {/* Left title + big remaining readout */}
      <div className={cn(wide ? 'w-44 shrink-0' : 'flex items-baseline justify-between gap-2')}>
        <div className="truncate text-2xs font-medium text-secondary-foreground" title={title}>
          {title}
        </div>
        <div className={cn('flex items-baseline gap-1.5', wide && 'mt-0.5')}>
          <span
            className={cn(
              'font-semibold tabular-nums tracking-tight text-foreground',
              wide ? 'text-xl leading-none' : 'text-base leading-none'
            )}
          >
            {remainingPercent}%
          </span>
          <span className="text-2xs text-muted-foreground">left</span>
        </div>
      </div>

      {/* Right thick bar with hatched used track, pace line & reset pill */}
      <div
        role="progressbar"
        aria-label={`${title} remaining`}
        aria-valuenow={remainingPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${remainingPercent}% left`}
        style={HATCHED_TRACK_STYLE}
        className={cn(
          'relative flex-1 overflow-hidden rounded-md border border-border/50 bg-background/60',
          wide ? 'h-7' : 'h-5'
        )}
      >
        <div
          className="h-full rounded-sm transition-[width] duration-300 ease-out"
          style={{
            width: `${remainingPercent}%`,
            backgroundColor: visual.barFill
          }}
        />
        {pacePct !== null && (
          <span
            aria-hidden="true"
            title="Expected pace based on reset window"
            className="pointer-events-none absolute top-0.5 bottom-0.5 w-0.5 rounded-full bg-foreground/80"
            style={{ left: `${pacePct}%` }}
          />
        )}
        {resetText && (
          <span className="pointer-events-none absolute top-1/2 right-1.5 inline-flex -translate-y-1/2 items-center gap-1 rounded bg-background/85 px-1.5 py-0.5 font-mono text-4xs text-secondary-foreground shadow-xs ring-1 ring-border/60">
            <RotateCcw size={9} aria-hidden="true" />
            {resetText}
          </span>
        )}
      </div>
    </div>
  )
}

export function UsageLimitsTab({
  wide,
  loading,
  providerFilter,
  claudeAccounts,
  claudeUsageById,
  antigravityAccounts,
  antigravityUsageById,
  onForceRefresh
}: UsageLimitsTabProps): React.JSX.Element {
  const showClaude =
    (providerFilter === 'all' || providerFilter === 'claude') && claudeAccounts.length > 0
  const showAntigravity =
    (providerFilter === 'all' || providerFilter === 'antigravity') && antigravityAccounts.length > 0

  if (loading && !showClaude && !showAntigravity) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
        <Spinner size={14} decorative />
        Loading live provider limits…
      </div>
    )
  }

  if (!showClaude && !showAntigravity) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <p className="text-xs font-medium text-foreground">No connected provider limits</p>
        <p className="max-w-xs text-2xs text-muted-foreground">
          Sign in to Claude or Antigravity in Settings → Accounts to monitor live 5-hour and weekly
          limits here.
        </p>
      </div>
    )
  }

  return (
    <div className={cn('mx-auto w-full space-y-6', wide && 'max-w-3xl')}>
      {showClaude && (
        <section className="space-y-2.5">
          {claudeAccounts.map((acc) => {
            const usage = claudeUsageById.get(acc.id)
            return (
              <div key={`claude-${acc.id}`} className="space-y-2">
                <div className="flex items-center gap-2 px-0.5">
                  <ProviderMark provider="claude" size={14} />
                  <h3 className="text-xs font-semibold text-foreground">Claude</h3>
                  <span className="truncate text-2xs text-muted-foreground">· {acc.name}</span>
                  {usage?.subscriptionType && (
                    <span className="rounded bg-muted px-1.5 py-px font-mono text-4xs uppercase text-secondary-foreground">
                      {usage.subscriptionType}
                    </span>
                  )}
                </div>

                {usage && usage.windows.length > 0 ? (
                  <div className="space-y-2">
                    {usage.windows.map((win) => (
                      <LimitRowCard
                        key={`${win.kind}-${win.scope ?? ''}`}
                        provider="claude"
                        title={claudeWindowTitle(win)}
                        usedPercent={win.percent}
                        resetsAt={win.resetsAt}
                        kind={win.kind}
                        wide={wide}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-card/30 px-4 py-3 text-2xs text-muted-foreground">
                    <span>{usage?.message || 'Quota data not available yet.'}</span>
                    <Button type="button" size="xs" variant="outline" onClick={onForceRefresh}>
                      Check now
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </section>
      )}

      {showAntigravity && (
        <section className="space-y-2.5">
          {antigravityAccounts.map((acc) => {
            const usage = antigravityUsageById.get(acc.id)
            return (
              <div key={`ag-${acc.id}`} className="space-y-2">
                <div className="flex items-center gap-2 px-0.5">
                  <ProviderMark provider="antigravity" size={14} />
                  <h3 className="text-xs font-semibold text-foreground">Antigravity</h3>
                  <span className="truncate text-2xs text-muted-foreground">· {acc.name}</span>
                  {usage?.planType && (
                    <span className="rounded bg-muted px-1.5 py-px font-mono text-4xs text-secondary-foreground">
                      {usage.planType}
                    </span>
                  )}
                </div>

                {usage && usage.windows.length > 0 ? (
                  <div className="space-y-2">
                    {usage.windows.map((win) => (
                      <LimitRowCard
                        key={win.modelId}
                        provider="antigravity"
                        title={formatLimitWindowTitle(win.label || win.modelId)}
                        usedPercent={win.percent}
                        resetsAt={win.resetsAt}
                        kind={win.kind}
                        wide={wide}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-card/30 px-4 py-3 text-2xs text-muted-foreground">
                    <span>
                      {usage?.message || 'Run a usage check or send a chat to load live limits.'}
                    </span>
                    <Button type="button" size="xs" variant="outline" onClick={onForceRefresh}>
                      Check now
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}
