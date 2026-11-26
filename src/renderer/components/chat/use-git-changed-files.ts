import type { DiscoveredGitRepo, GitDiffStat, GitStatusDetail } from '@shared/types/ipc.types'
import { useEffect, useMemo, useRef } from 'react'
import type { GitDisplayStatus } from '@/lib/git-status-display'
import { logFrontendError } from '@/lib/log-api'
import { normalizePath } from '@/lib/working-copy'
import { isMultiRepoWorkspace, useGitReposStore } from '@/stores/git-repos-store'
import { selectGitDiffStat, useGitStatusStore } from '@/stores/git-status-store'

export const GIT_CHANGES_REFRESH_DEBOUNCE_MS = 500
const EMPTY_REPOS: DiscoveredGitRepo[] = []

/** One uncommitted file of the checkout. `path` is repository-root relative (or absolute when `repoRoot` is set). */
export interface GitChangedFile {
  path: string
  status: GitDisplayStatus
  added: number
  removed: number
  /** True when the file has staged changes in the index. */
  staged?: boolean
  /** True when the file has unstaged working-tree changes. */
  hasUnstaged?: boolean
  /** Repository root path when aggregated across multiple nested repos. */
  repoRoot?: string
  /** Display label of the owning repository in a multi-repo workspace. */
  repoLabel?: string
}

/**
 * `loading`: the status or the diff stat (which carries the repository root)
 * for the cwd has not been read yet. `unavailable`: the cwd is empty or git
 * status failed before any success (not a repository). `root`: the base of the
 * file paths — the repository root, or the cwd when the diff stat failed or
 * the host does not report the root.
 */
export type GitChangedFiles =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; root: string; files: GitChangedFile[] }

/** The working-tree state wins; a staged add, rename or delete shows over a
 * later unstaged edit. */
function displayStatus(entries: GitStatusDetail[]): GitDisplayStatus {
  const staged = entries.find((entry) => entry.staged)?.status
  const unstaged = entries.find((entry) => !entry.staged)?.status
  if (unstaged && unstaged !== 'modified' && unstaged !== 'staged') return unstaged
  if (staged && staged !== 'modified' && staged !== 'staged') return staged
  return 'modified'
}

/** One row per path of the status list (porcelain order), with the line
 * counts of the diff stat. A path the stat does not list yet counts 0. */
export function gitChangedFiles(
  statuses: readonly GitStatusDetail[],
  stat: GitDiffStat | null
): GitChangedFile[] {
  const byPath = new Map<string, GitStatusDetail[]>()
  for (const entry of statuses) {
    const entries = byPath.get(entry.path)
    if (entries) entries.push(entry)
    else byPath.set(entry.path, [entry])
  }
  const counts = new Map((stat?.files ?? []).map((file) => [file.path, file]))
  return Array.from(byPath, ([path, entries]) => ({
    path,
    status: displayStatus(entries),
    added: counts.get(path)?.added ?? 0,
    removed: counts.get(path)?.removed ?? 0,
    staged: entries.some((entry) => entry.staged),
    hasUnstaged: entries.some((entry) => !entry.staged)
  }))
}

const LOADING: GitChangedFiles = { state: 'loading' }
const UNAVAILABLE: GitChangedFiles = { state: 'unavailable' }

/**
 * Live uncommitted files of the checkout at `cwd`, read from the git status
 * store. Refreshes on mount, and debounced when the agent's tool calls change
 * or its turn ends: an agent's own `git commit` or file delete touches no file
 * the watcher reports. Focus, the poll, terminal git events, file changes and
 * own git writes refresh the same store entries.
 */
export function useGitChangedFiles(
  cwd: string,
  toolCalls: unknown,
  turnActive: boolean
): GitChangedFiles {
  const key = cwd ? normalizePath(cwd) : ''
  const discoveredRepos = useGitReposStore((state) =>
    key ? (state.reposByRoot[key] ?? EMPTY_REPOS) : EMPTY_REPOS
  )
  const multiRepo = isMultiRepoWorkspace(discoveredRepos)

  useEffect(() => {
    if (!cwd) return
    void useGitReposStore.getState().discover(cwd)
  }, [cwd])

  const allStatuses = useGitStatusStore((state) => (multiRepo ? state.statuses : null))
  const allDiffStats = useGitStatusStore((state) => (multiRepo ? state.diffStats : null))
  const statuses = useGitStatusStore((state) =>
    key && !multiRepo ? state.statuses[key] : undefined
  )
  const statusError = useGitStatusStore((state) =>
    key && !multiRepo ? state.errors[key]?.status : undefined
  )
  const diffStatError = useGitStatusStore((state) =>
    key && !multiRepo ? state.errors[key]?.diffStat : undefined
  )
  const stat = useGitStatusStore(selectGitDiffStat(multiRepo ? '' : cwd))

  // Declared before the refresh effect: an unwatched key skips the diff stat.
  useEffect(() => {
    if (!cwd) return
    const store = useGitStatusStore.getState()
    if (multiRepo) {
      const cleanups = discoveredRepos.map((repo) => store.watchDiffStat(repo.path))
      return () => {
        for (const cleanup of cleanups) cleanup()
      }
    }
    return store.watchDiffStat(cwd)
  }, [cwd, multiRepo, discoveredRepos])

  const refreshedTarget = useRef<string | null>(null)
  const targetKey = multiRepo ? `${cwd}|${discoveredRepos.map((r) => r.path).join('|')}` : cwd
  // biome-ignore lint/correctness/useExhaustiveDependencies: toolCalls and turnActive are refresh triggers only
  useEffect(() => {
    if (!cwd) return
    const refresh = () => {
      const store = useGitStatusStore.getState()
      const targets = multiRepo ? discoveredRepos.map((r) => r.path) : [cwd]
      for (const target of targets) {
        // Failures are stored in `errors` and logged by the store.
        void store.refreshStatus(target).catch(() => {})
        void store.refreshDiffStat(target)
      }
    }
    if (refreshedTarget.current !== targetKey) {
      refreshedTarget.current = targetKey
      refresh()
      return
    }
    const timer = setTimeout(refresh, GIT_CHANGES_REFRESH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [cwd, targetKey, multiRepo, discoveredRepos, toolCalls, turnActive])

  const result = useMemo<GitChangedFiles>(() => {
    if (!key) return UNAVAILABLE
    if (multiRepo && allStatuses && allDiffStats) {
      const merged: GitChangedFile[] = []
      let anyReady = false
      for (const repo of discoveredRepos) {
        const repoKey = normalizePath(repo.path)
        const repoStatuses = allStatuses[repoKey]
        if (!repoStatuses) continue
        anyReady = true
        const repoStat = allDiffStats[repoKey] ?? null
        const repoRoot = repoStat?.root || repo.path
        const repoLabel = repo.isRoot ? repo.name : repo.relativePath
        for (const file of gitChangedFiles(repoStatuses, repoStat)) {
          merged.push({
            ...file,
            repoRoot,
            repoLabel
          })
        }
      }
      if (!anyReady) return LOADING
      return { state: 'ready', root: cwd, files: merged }
    }
    if (!statuses) return statusError === undefined ? LOADING : UNAVAILABLE
    if (!stat && diffStatError === undefined) return LOADING
    const root = stat?.root || cwd
    return { state: 'ready', root, files: gitChangedFiles(statuses, stat) }
  }, [
    key,
    cwd,
    multiRepo,
    discoveredRepos,
    allStatuses,
    allDiffStats,
    statuses,
    stat,
    statusError,
    diffStatError
  ])

  const loggedUnavailableFor = useRef<string | null>(null)
  useEffect(() => {
    if (result.state !== 'unavailable' || !cwd || loggedUnavailableFor.current === cwd) return
    loggedUnavailableFor.current = cwd
    void logFrontendError({
      level: 'info',
      message: `useGitChangedFiles: git status unavailable for ${cwd}; showing agent tool-call edits`,
      source: 'useGitChangedFiles'
    })
  }, [result.state, cwd])

  return result
}
