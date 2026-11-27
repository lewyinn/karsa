import type {
  ClaudeAccountsSnapshot,
  ClaudeAccountUsage
} from '@shared/types/claude-accounts.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { claudeAccountsApi } from '@/lib/claude-accounts-api'
import { useUsageHistoryStore } from '@/stores/usage-history-store'

/** Poll Claude usage every 60s and right after turns settle for realtime quota bars. */
export const CLAUDE_USAGE_POLL_MS = 60 * 1000
const TURN_USAGE_REFRESH_DEBOUNCE_MS = 3_000

export interface ClaudeAccountsState {
  snapshot: ClaudeAccountsSnapshot | null
  /** Latest usage read per Account id. */
  usage: Record<string, ClaudeAccountUsage>
  loading: boolean
  /** Why the Account list could not be read. */
  error: string | null
  refreshingUsage: boolean
  reload: () => Promise<void>
  refreshUsage: (force?: boolean) => Promise<void>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const mountedLists = new Set<() => void>()

/** Read the Account list again in every mounted {@link useClaudeAccounts}, e.g. after the host moved a chat. */
export function reloadClaudeAccounts(): void {
  for (const reload of mountedLists) reload()
}

/**
 * The Claude Account list and its usage, read on mount and every 5 minutes
 * while mounted. `usage: false` skips the usage reads; `enabled: false` reads
 * nothing (a closed modal that stays mounted).
 */
export function useClaudeAccounts(
  options: { usage?: boolean; enabled?: boolean } = {}
): ClaudeAccountsState {
  const withUsage = options.usage ?? true
  const enabled = options.enabled ?? true
  const [snapshot, setSnapshot] = useState<ClaudeAccountsSnapshot | null>(null)
  const [usage, setUsage] = useState<Record<string, ClaudeAccountUsage>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshingUsage, setRefreshingUsage] = useState(false)
  const mounted = useRef(true)

  const reload = useCallback(async () => {
    try {
      const next = await claudeAccountsApi.list()
      if (!mounted.current) return
      setSnapshot(next)
      setError(null)
    } catch (err) {
      if (mounted.current) setError(message(err))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  const refreshUsage = useCallback(async (force = false) => {
    setRefreshingUsage(true)
    try {
      const reads = await claudeAccountsApi.usage(force)
      if (!mounted.current) return
      setUsage(Object.fromEntries(reads.map((read) => [read.accountId, read])))
    } catch {
      // The facade logs the failure; the rows keep their last read.
    } finally {
      if (mounted.current) setRefreshingUsage(false)
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
    if (!withUsage) {
      return () => {
        mounted.current = false
      }
    }
    void refreshUsage(false)
    const timer = setInterval(() => void refreshUsage(false), CLAUDE_USAGE_POLL_MS)
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
      unsubscribeUsage()
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(timer)
    }
  }, [reload, refreshUsage, withUsage, enabled])

  useEffect(() => {
    if (!enabled) return
    const listener = (): void => void reload()
    mountedLists.add(listener)
    return () => {
      mountedLists.delete(listener)
    }
  }, [reload, enabled])

  return { snapshot, usage, loading, error, refreshingUsage, reload, refreshUsage }
}
