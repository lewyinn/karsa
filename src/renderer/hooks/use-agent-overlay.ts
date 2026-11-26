import { useEffect } from 'react'
import { loadAgentOverlay } from '@/lib/agents/agent-overlay'

/** The host refreshes its copy hourly; ask again at the same cadence. */
const RELOAD_INTERVAL_MS = 60 * 60 * 1000
/**
 * The first failed load in a row (socket still connecting, host restarting)
 * retries sooner. A host that keeps refusing (an older host without the
 * request) falls back to the hourly cadence.
 */
const RETRY_AFTER_FAILURE_MS = 60 * 1000

/** Load Karsa's registry overlay on mount, then hourly. Both roots. */
export function useAgentOverlayLoader(): void {
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let failures = 0
    const run = async (): Promise<void> => {
      failures = (await loadAgentOverlay()) ? 0 : failures + 1
      if (cancelled) return
      const delay = failures === 1 ? RETRY_AFTER_FAILURE_MS : RELOAD_INTERVAL_MS
      timer = window.setTimeout(() => void run(), delay)
    }
    void run()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])
}
