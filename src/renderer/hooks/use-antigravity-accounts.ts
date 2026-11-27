import type {
  AntigravityAccountsSnapshot,
  AntigravityAccountUsage
} from '@shared/types/antigravity-accounts.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeAntigravityAccountList } from '@/lib/antigravity-account-list'
import { antigravityLaunchConfig } from '@/lib/antigravity-account-sign-in'
import { antigravityAccountsApi } from '@/lib/antigravity-accounts-api'
import { useUsageHistoryStore } from '@/stores/usage-history-store'

export const ANTIGRAVITY_USAGE_POLL_MS = 60 * 1000
const TURN_USAGE_REFRESH_DEBOUNCE_MS = 3_000

export interface AntigravityAccountsState {
  snapshot: AntigravityAccountsSnapshot | null
  /** Latest usage read per Account id. */
  usage: Record<string, AntigravityAccountUsage>
  loading: boolean
  /** Why the Account list could not be read. */
  error: string | null
  refreshingUsage: boolean
  checkingAccountIds: ReadonlySet<string>
  reload: () => Promise<void>
  refreshUsage: (force?: boolean) => Promise<void>
  checkUsage: (accountId: string) => Promise<void>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The Antigravity Account list, read on mount. `usage: true` also re-reads the
 * last usage checks every 5 minutes. `enabled: false` reads nothing (a closed
 * modal that stays mounted, or a chat that is not an Antigravity chat).
 */
export function useAntigravityAccounts(
  options: { enabled?: boolean; usage?: boolean } = {}
): AntigravityAccountsState {
  const enabled = options.enabled ?? true
  const withUsage = options.usage ?? false
  const [snapshot, setSnapshot] = useState<AntigravityAccountsSnapshot | null>(null)
  const [usage, setUsage] = useState<Record<string, AntigravityAccountUsage>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshingUsage, setRefreshingUsage] = useState(false)
  const [checkingAccountIds, setCheckingAccountIds] = useState<ReadonlySet<string>>(() => new Set())
  const mounted = useRef(true)

  const reloadGeneration = useRef(0)
  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current
    const current = () => mounted.current && generation === reloadGeneration.current
    try {
      const next = await antigravityAccountsApi.list()
      if (!current()) return
      setSnapshot(next)
      setError(null)
    } catch (err) {
      if (current()) setError(message(err))
    } finally {
      if (current()) setLoading(false)
    }
  }, [])

  const refreshUsage = useCallback(async (force = false) => {
    setRefreshingUsage(true)
    try {
      const reads = await antigravityAccountsApi.usage(force)
      if (!mounted.current) return
      setUsage(Object.fromEntries(reads.map((read) => [read.accountId, read])))
    } catch {
      // The facade logs the failure. Rows keep the last good read.
    } finally {
      if (mounted.current) setRefreshingUsage(false)
    }
  }, [])

  const checkUsage = useCallback(async (accountId: string) => {
    setCheckingAccountIds((ids) => new Set(ids).add(accountId))
    try {
      const read = await antigravityAccountsApi.checkUsage(accountId, antigravityLaunchConfig())
      if (mounted.current) setUsage((reads) => ({ ...reads, [accountId]: read }))
    } finally {
      if (mounted.current) {
        setCheckingAccountIds((ids) => {
          const next = new Set(ids)
          next.delete(accountId)
          return next
        })
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    if (!enabled) {
      return () => {
        mounted.current = false
      }
    }
    void reload()
    const unsubscribeList = subscribeAntigravityAccountList(() => {
      void reload()
    })
    if (!withUsage) {
      return () => {
        mounted.current = false
        unsubscribeList()
      }
    }
    void refreshUsage(false)
    const timer = setInterval(() => void refreshUsage(false), ANTIGRAVITY_USAGE_POLL_MS)
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let prevSessions = useUsageHistoryStore.getState().sessions
    const unsubscribeUsage = useUsageHistoryStore.subscribe((state) => {
      if (state.sessions === prevSessions) return
      prevSessions = state.sessions
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => void refreshUsage(false), TURN_USAGE_REFRESH_DEBOUNCE_MS)
    })
    return () => {
      mounted.current = false
      unsubscribeList()
      unsubscribeUsage()
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(timer)
    }
  }, [reload, refreshUsage, withUsage, enabled])

  return {
    snapshot,
    usage,
    loading,
    error,
    refreshingUsage,
    checkingAccountIds,
    reload,
    refreshUsage,
    checkUsage
  }
}
