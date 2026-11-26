import type { DiscoveredGitRepo } from '@shared/types/ipc.types'
import { FolderGit2 } from '@/components/icons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { normalizePath } from '@/lib/working-copy'
import { useGitStatusStore } from '@/stores/git-status-store'

export const ALL_REPOS_VALUE = '__all_repos__'

interface RepoSwitcherBarProps {
  repos: readonly DiscoveredGitRepo[]
  /** Currently selected repo path, or `ALL_REPOS_VALUE` when `allowAll` is active. */
  value: string
  /** Show an "All repos" option (used in GitHub panel). */
  allowAll?: boolean
  /** Show uncommitted change counts next to each repo label (used in Changes panel). */
  showCounts?: boolean
  onSelectRepo: (repoPath: string) => void
  onSelectAll?: () => void
}

/**
 * Compact synced repository selector shown in the Changes and GitHub panels
 * whenever a workspace contains multiple nested Git repos (e.g. frontend + backend).
 */
export function RepoSwitcherBar({
  repos,
  value,
  allowAll = false,
  showCounts = false,
  onSelectRepo,
  onSelectAll
}: RepoSwitcherBarProps): React.JSX.Element | null {
  const statuses = useGitStatusStore((s) => (showCounts ? s.statuses : null))

  if (repos.length === 0) return null
  if (repos.length === 1 && repos[0].isRoot) return null

  const countFor = (repoPath: string): number => {
    if (!statuses) return 0
    const entries = statuses[normalizePath(repoPath)]
    if (!entries) return 0
    return new Set(entries.map((e) => e.path)).size
  }

  return (
    <div
      data-testid="repo-switcher-bar"
      className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 pointer-coarse:h-11"
    >
      <FolderGit2 size={13} aria-hidden="true" className="shrink-0 text-muted-foreground" />
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === ALL_REPOS_VALUE) {
            onSelectAll?.()
          } else {
            onSelectRepo(next)
          }
        }}
      >
        <SelectTrigger
          aria-label="Workspace repository"
          className="h-7 min-w-0 flex-1 gap-1 rounded-md border-transparent bg-transparent px-1.5 text-xs font-medium pointer-coarse:h-11 pointer-coarse:text-sm [&>span]:truncate"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowAll && repos.length > 1 && (
            <SelectItem value={ALL_REPOS_VALUE}>All repos ({repos.length})</SelectItem>
          )}
          {repos.map((repo) => {
            const count = showCounts ? countFor(repo.path) : 0
            const label = repo.isRoot ? `${repo.name} (root)` : repo.name
            return (
              <SelectItem key={repo.path} value={repo.path}>
                <span className="flex items-center gap-2">
                  <span>{label}</span>
                  {count > 0 && (
                    <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                      · {count}
                    </span>
                  )}
                </span>
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    </div>
  )
}
