import type { GithubListFilter, GithubListItem } from '@shared/types/github.types'
import type { DiscoveredGitRepo } from '@shared/types/ipc.types'
import { useEffect, useMemo } from 'react'
import { GitPullRequest, Plus, RefreshCw } from '@/components/icons'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  DEFAULT_GITHUB_FILTER,
  githubListKey,
  resourceOf,
  useGithubStore
} from '@/stores/github-store'
import { githubItemTabId } from '@/stores/workspace-store'
import { GithubFilters } from './GithubFilters'
import { GithubListRow } from './GithubListRow'

interface MergedGithubItem {
  repo: DiscoveredGitRepo
  item: GithubListItem
}

interface AllReposGithubViewProps {
  repos: readonly DiscoveredGitRepo[]
  activeTabId: string | null
  onOpenItem: (repoCwd: string, item: GithubListItem) => void
  onOpenCreateIssue: () => void
  onOpenCreatePr: () => void
}

/**
 * Combined GitHub Issues & PRs list across every Git repo discovered in a
 * multi-repo workspace (e.g. `frontend` + `backend`), tagged per row by repo.
 */
export function AllReposGithubView({
  repos,
  activeTabId,
  onOpenItem,
  onOpenCreateIssue,
  onOpenCreatePr
}: AllReposGithubViewProps): React.JSX.Element {
  const primaryCwd = repos[0]?.path ?? ''
  const contexts = useGithubStore((s) => s.contexts)
  const lists = useGithubStore((s) => s.lists)
  const filter = useGithubStore((s) =>
    primaryCwd ? (s.filters[primaryCwd] ?? DEFAULT_GITHUB_FILTER) : DEFAULT_GITHUB_FILTER
  )
  const { loadContext, loadList, setFilter } = useGithubStore.getState()

  useEffect(() => {
    for (const repo of repos) {
      void loadContext(repo.path)
    }
  }, [repos, loadContext])

  const resolvedRepos = useMemo(
    () =>
      repos.filter((repo) => {
        const ctx = resourceOf(contexts[repo.path]).data
        return ctx?.repo.kind === 'resolved' && ctx.auth.state === 'connected'
      }),
    [repos, contexts]
  )

  useEffect(() => {
    for (const repo of resolvedRepos) {
      void loadList(repo.path)
    }
  }, [resolvedRepos, loadList])

  const handleFilterChange = (patch: Partial<GithubListFilter>): void => {
    for (const repo of repos) {
      setFilter(repo.path, { ...patch, repo: 'origin' })
    }
  }

  const handleRefreshAll = (): void => {
    for (const repo of repos) {
      void loadContext(repo.path)
      void loadList(repo.path, { refresh: true })
    }
  }

  const refreshing = resolvedRepos.some((repo) => {
    const repoFilter = { ...filter, repo: 'origin' as const }
    return resourceOf(lists[githubListKey(repo.path, repoFilter)]).status === 'loading'
  })

  const anyContextLoading = repos.some((repo) => {
    const ctx = resourceOf(contexts[repo.path])
    return !ctx.data && ctx.status !== 'error'
  })

  const merged = useMemo<MergedGithubItem[]>(() => {
    const out: MergedGithubItem[] = []
    for (const repo of resolvedRepos) {
      const repoFilter = { ...filter, repo: 'origin' as const }
      const list = resourceOf(lists[githubListKey(repo.path, repoFilter)])
      if (!list.data) continue
      for (const item of list.data.items) {
        out.push({ repo, item })
      }
    }
    out.sort((a, b) => Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt))
    return out
  }, [resolvedRepos, lists, filter])

  const anyListLoaded = resolvedRepos.some((repo) => {
    const repoFilter = { ...filter, repo: 'origin' as const }
    return resourceOf(lists[githubListKey(repo.path, repoFilter)]).data !== null
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GithubFilters
        cwd={primaryCwd}
        filter={filter}
        onChange={handleFilterChange}
        action={
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={onOpenCreateIssue}
              className={cn(PANEL_ICON_BUTTON_CLASS, 'shrink-0 pointer-coarse:size-11')}
              title="New issue"
              aria-label="New issue"
            >
              <Plus size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onOpenCreatePr}
              className={cn(PANEL_ICON_BUTTON_CLASS, 'shrink-0 pointer-coarse:size-11')}
              title="New pull request"
              aria-label="New pull request"
            >
              <GitPullRequest size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={handleRefreshAll}
              disabled={refreshing}
              className={cn(PANEL_ICON_BUTTON_CLASS, 'shrink-0 pointer-coarse:size-11')}
              title="Refresh all repositories"
              aria-label="Refresh"
            >
              <RefreshCw
                size={14}
                aria-hidden="true"
                className={cn(refreshing && 'animate-spin')}
              />
            </button>
          </div>
        }
      />

      {anyContextLoading || (resolvedRepos.length > 0 && !anyListLoaded && refreshing) ? (
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading"
          className="flex flex-col gap-2 px-3 py-2"
        >
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      ) : resolvedRepos.length === 0 ? (
        <p className="my-auto px-4 py-6 text-center text-xs text-muted-foreground">
          No connected GitHub repositories found in this workspace. Pick a repository above to sign
          in or inspect its status.
        </p>
      ) : merged.length === 0 ? (
        <p className="my-auto px-4 py-6 text-center text-xs text-muted-foreground">
          Nothing matches these filters across {resolvedRepos.length} repositories.
        </p>
      ) : (
        <ul
          aria-label="Issues and pull requests across all repositories"
          className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
        >
          {merged.map(({ repo, item }) => (
            <GithubListRow
              key={`${repo.path}-${item.kind}-${item.number}`}
              item={item}
              repoBadge={repo.isRoot ? repo.name : repo.relativePath}
              isActive={activeTabId === githubItemTabId(repo.path, 'origin', item.number)}
              onOpen={(clicked) => onOpenItem(repo.path, clicked)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
