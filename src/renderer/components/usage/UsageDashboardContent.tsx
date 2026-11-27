import type {
  AntigravityAccountsSnapshot,
  AntigravityAccountUsage
} from '@shared/types/antigravity-accounts.types'
import type {
  ClaudeAccountsSnapshot,
  ClaudeAccountUsage
} from '@shared/types/claude-accounts.types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ChevronDown, RefreshCw, X } from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { antigravityLaunchConfig } from '@/lib/antigravity-account-sign-in'
import { antigravityAccountsApi } from '@/lib/antigravity-accounts-api'
import { claudeAccountsApi } from '@/lib/claude-accounts-api'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import {
  filterSessionsByRange,
  providerKeyOf,
  type UsageProviderKey,
  type UsageRange,
  useUsageHistoryStore
} from '@/stores/usage-history-store'
import { UsageAnalyticsTab } from './UsageAnalyticsTab'
import { UsageLimitsTab } from './UsageLimitsTab'
import { PROVIDER_VISUALS } from './usage-theme'

export type UsageViewTab = 'cost' | 'tokens' | 'limits'

const LIVE_QUOTA_POLL_MS = 30_000
const TURN_QUOTA_DEBOUNCE_MS = 2_500

const RANGE_OPTIONS: ReadonlyArray<{ value: UsageRange; label: string; shortLabel: string }> = [
  { value: '24h', label: 'Past 24h', shortLabel: '24h' },
  { value: '7d', label: '7 days', shortLabel: '7d' },
  { value: '30d', label: '30 days', shortLabel: '30d' },
  { value: '90d', label: '90 days', shortLabel: '90d' }
]

interface LiveQuotasState {
  loading: boolean
  claudeAccounts: ClaudeAccountsSnapshot['accounts']
  claudeUsage: ClaudeAccountUsage[]
  antigravityAccounts: AntigravityAccountsSnapshot['accounts']
  antigravityUsage: AntigravityAccountUsage[]
}

export interface UsageDashboardContentProps {
  wide?: boolean
  initialTab?: UsageViewTab
  onTabChange?: (tab: UsageViewTab) => void
  onClose?: () => void
}

export function UsageDashboardContent({
  wide = false,
  initialTab = 'limits',
  onTabChange,
  onClose
}: UsageDashboardContentProps): React.JSX.Element {
  const sessionsMap = useUsageHistoryStore((state) => state.sessions)
  const pricing = useUsageHistoryStore((state) => state.pricing)
  const loadingPricing = useUsageHistoryStore((state) => state.loadingPricing)

  const [activeTab, setActiveTabState] = useState<UsageViewTab>(initialTab)
  const [range, setRange] = useState<UsageRange>('30d')
  const [projectFilter, setProjectFilter] = useState<string>('all')
  const [providerFilter, setProviderFilter] = useState<UsageProviderKey | 'all'>('all')
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)
  const [quotas, setQuotas] = useState<LiveQuotasState>({
    loading: false,
    claudeAccounts: [],
    claudeUsage: [],
    antigravityAccounts: [],
    antigravityUsage: []
  })
  const mountedRef = useRef(true)

  const setActiveTab = (tab: UsageViewTab): void => {
    setActiveTabState(tab)
    onTabChange?.(tab)
  }

  const refreshQuotas = useCallback(async (force = false) => {
    setQuotas((prev) => ({ ...prev, loading: true }))
    try {
      const [claudeList, claudeUsage, agList, cachedAgUsage] = await Promise.all([
        claudeAccountsApi.list().catch(() => null),
        claudeAccountsApi.usage(force).catch(() => []),
        antigravityAccountsApi.list().catch(() => null),
        antigravityAccountsApi.usage(force).catch(() => [])
      ])
      let agUsage = cachedAgUsage
      if (force && agList?.accounts.length) {
        try {
          const config = antigravityLaunchConfig()
          const signedInIds = agList.accounts
            .filter((acc) => acc.signedIn !== false)
            .map((acc) => acc.id)
          if (signedInIds.length > 0) {
            const freshChecks = await Promise.all(
              signedInIds.map((id) =>
                antigravityAccountsApi.checkUsage(id, config).catch(() => null)
              )
            )
            const freshById = new Map(
              freshChecks
                .filter((read): read is AntigravityAccountUsage => read !== null)
                .map((read) => [read.accountId, read])
            )
            if (freshById.size > 0) {
              const merged = new Map(agUsage.map((read) => [read.accountId, read]))
              for (const [id, read] of freshById) merged.set(id, read)
              agUsage = [...merged.values()]
            }
          }
        } catch {
          // Antigravity agent unavailable — keep cached reads.
        }
      }
      if (!mountedRef.current) return
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
      if (mountedRef.current) {
        setQuotas((prev) => ({ ...prev, loading: false }))
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void useUsageHistoryStore.getState().refreshPricing(false)
    void refreshQuotas(false)
    const poll = setInterval(() => void refreshQuotas(false), LIVE_QUOTA_POLL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(poll)
    }
  }, [refreshQuotas])

  // Realtime sync whenever a chat turn records new token usage.
  const latestSessionUpdate = useMemo(() => {
    let max = 0
    for (const s of Object.values(sessionsMap)) {
      if (s.updatedAt > max) max = s.updatedAt
    }
    return max
  }, [sessionsMap])
  const lastSeenUpdateRef = useRef(latestSessionUpdate)

  useEffect(() => {
    if (latestSessionUpdate <= lastSeenUpdateRef.current) return
    lastSeenUpdateRef.current = latestSessionUpdate
    const timer = setTimeout(() => void refreshQuotas(false), TURN_QUOTA_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [latestSessionUpdate, refreshQuotas])

  const allSessions = useMemo(
    () => Object.values(sessionsMap).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessionsMap]
  )

  const availableProjects = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of allSessions) {
      const id = s.projectId || 'unassigned'
      if (!map.has(id)) map.set(id, s.projectName || 'Quick chats')
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [allSessions])

  const availableProviders = useMemo(() => {
    const set = new Set<UsageProviderKey>()
    if (quotas.claudeAccounts.length > 0) set.add('claude')
    if (quotas.antigravityAccounts.length > 0) set.add('antigravity')
    for (const s of allSessions) {
      set.add(providerKeyOf(s.agentName, s.modelId))
    }
    return [...set]
  }, [quotas.claudeAccounts.length, quotas.antigravityAccounts.length, allSessions])

  const filteredSessions = useMemo(() => {
    const byRange = filterSessionsByRange(allSessions, range)
    return byRange.filter((s) => {
      if (projectFilter !== 'all') {
        const id = s.projectId || 'unassigned'
        if (id !== projectFilter) return false
      }
      if (providerFilter !== 'all') {
        if (providerKeyOf(s.agentName, s.modelId) !== providerFilter) return false
      }
      return true
    })
  }, [allSessions, range, projectFilter, providerFilter])

  const claudeUsageById = useMemo(
    () => new Map(quotas.claudeUsage.map((u) => [u.accountId, u])),
    [quotas.claudeUsage]
  )
  const agUsageById = useMemo(
    () => new Map(quotas.antigravityUsage.map((u) => [u.accountId, u])),
    [quotas.antigravityUsage]
  )

  const selectedProjectLabel =
    projectFilter === 'all'
      ? 'All projects'
      : (availableProjects.find((p) => p.id === projectFilter)?.name ?? 'Project')
  const selectedProviderLabel =
    providerFilter === 'all'
      ? availableProviders.length === 1
        ? '1 provider'
        : `${Math.max(availableProviders.length, 1)} providers`
      : PROVIDER_VISUALS[providerFilter].label

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Top Breadcrumb + Filters + Range + Cost/Tokens/Limits Bar */}
      <div
        className={cn(
          'flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70',
          wide ? 'px-5 py-3' : 'px-3 py-2'
        )}
      >
        {/* Left breadcrumb filters */}
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          {wide && (
            <>
              <span className="font-medium text-muted-foreground">Usage</span>
              <span className="text-muted-foreground/50">/</span>
            </>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex max-w-36 items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                <span className="truncate">{selectedProjectLabel}</span>
                <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuItem onSelect={() => setProjectFilter('all')}>
                All projects
              </DropdownMenuItem>
              {availableProjects.map((project) => (
                <DropdownMenuItem key={project.id} onSelect={() => setProjectFilter(project.id)}>
                  {project.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="text-muted-foreground/50">/</span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                <span>{selectedProviderLabel}</span>
                <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuItem onSelect={() => setProviderFilter('all')}>
                All providers
              </DropdownMenuItem>
              {availableProviders.map((provider) => (
                <DropdownMenuItem key={provider} onSelect={() => setProviderFilter(provider)}>
                  {PROVIDER_VISUALS[provider].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Right controls: time range + Cost/Tokens/Limits + Refresh + Close */}
        <div className="flex flex-wrap items-center gap-2">
          {activeTab !== 'limits' && (
            <div className="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/25 p-0.5">
              {RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setRange(opt.value)}
                  className={cn(
                    'rounded px-2 py-0.5 text-3xs font-medium transition-colors',
                    range === opt.value
                      ? 'bg-card text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {wide ? opt.label : opt.shortLabel}
                </button>
              ))}
            </div>
          )}

          <div
            role="tablist"
            aria-label="Usage view"
            className="inline-flex items-center gap-0.5 rounded-md border border-border/70 bg-muted/30 p-0.5"
          >
            {(
              [
                { id: 'cost', label: 'Cost' },
                { id: 'tokens', label: 'Tokens' },
                { id: 'limits', label: 'Limits' }
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'rounded px-2.5 py-0.5 text-2xs font-medium transition-colors',
                  activeTab === tab.id
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={quotas.loading}
            onClick={() => void refreshQuotas(true)}
            title="Refresh live quotas"
            aria-label="Refresh live quotas"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw size={12} className={cn(quotas.loading && 'animate-spin')} />
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close usage dialog"
              aria-label="Close usage dialog"
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Active Tab Content */}
      <div className={cn('scroller-thin min-h-0 flex-1 overflow-y-auto', wide ? 'p-6' : 'p-3')}>
        {activeTab === 'limits' ? (
          <UsageLimitsTab
            wide={wide}
            loading={quotas.loading}
            providerFilter={providerFilter}
            claudeAccounts={quotas.claudeAccounts}
            claudeUsageById={claudeUsageById}
            antigravityAccounts={quotas.antigravityAccounts}
            antigravityUsageById={agUsageById}
            onForceRefresh={() => void refreshQuotas(true)}
          />
        ) : (
          <UsageAnalyticsTab
            metric={activeTab}
            wide={wide}
            range={range}
            sessions={filteredSessions}
            pricingModels={pricing.models}
            pricingSource={pricing.source}
            loadingPricing={loadingPricing}
            hasAnyHistory={allSessions.length > 0}
            onRefreshPricing={() => void useUsageHistoryStore.getState().refreshPricing(true)}
            onRequestClear={() => setConfirmClearOpen(true)}
          />
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmClearOpen}
        title="Clear usage history?"
        message="This resets your locally recorded token and estimated cost history. Live account limits are unaffected."
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
