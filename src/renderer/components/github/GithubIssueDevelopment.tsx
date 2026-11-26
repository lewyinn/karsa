import type { GithubListItem, GithubRepoSlot } from '@shared/types/github.types'
import type { GitCommit } from '@shared/types/ipc.types'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommit as GitCommitIcon,
  GitPullRequest,
  MessageSquare,
  RefreshCw
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { gitApi } from '@/lib/api'
import { githubApi } from '@/lib/github-api'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useGitStatusStore } from '@/stores/git-status-store'
import { DEFAULT_GITHUB_FILTER } from '@/stores/github-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { relativeAgo } from './github-status'

export type IssueDevStatus = 'not_started' | 'in_progress' | 'pr_open' | 'merged'

/** Match branch names referencing issue N (e.g. `fix/42-login`, `feat/42`, `issue-42-auth`). */
export function branchMatchesIssue(branchName: string, issueNumber: number): boolean {
  const escaped = String(issueNumber)
  const pattern = new RegExp(`(?:^|[/_-])(?:issue[/_-]?)?${escaped}(?:$|[/_-])`, 'i')
  return pattern.test(branchName.trim())
}

/** Match commits mentioning `#N` in subject or decorated by an issue-linked branch ref. */
export function commitMatchesIssue(
  commit: Pick<GitCommit, 'subject' | 'refs'>,
  issueNumber: number,
  matchingBranches: ReadonlySet<string>
): boolean {
  const escaped = String(issueNumber)
  const hashMention = new RegExp(`(?<![A-Za-z0-9])#${escaped}(?!\\d)`)
  if (hashMention.test(commit.subject)) return true
  if (commit.refs.length > 0 && matchingBranches.size > 0) {
    for (const rawRef of commit.refs) {
      const cleaned = rawRef
        .replace(/^HEAD ->\s*/i, '')
        .replace(/^origin\//, '')
        .trim()
      if (matchingBranches.has(cleaned)) return true
    }
  }
  return false
}

/** Match PRs referencing `#N` in title. */
export function prMatchesIssue(pr: GithubListItem, issueNumber: number): boolean {
  if (pr.kind !== 'pr') return false
  const escaped = String(issueNumber)
  const hashMention = new RegExp(`(?<![A-Za-z0-9])#${escaped}(?!\\d)`)
  return hashMention.test(pr.title)
}

export function computeIssueDevStatus(
  branches: readonly string[],
  commits: readonly GitCommit[],
  prs: readonly GithubListItem[]
): IssueDevStatus {
  if (prs.some((pr) => pr.state === 'merged')) return 'merged'
  if (prs.some((pr) => pr.state === 'open')) return 'pr_open'
  if (branches.length > 0 || commits.length > 0 || prs.length > 0) return 'in_progress'
  return 'not_started'
}

export function buildProgressCommentMarkdown(
  issueNumber: number,
  branches: readonly string[],
  commits: readonly GitCommit[],
  prs: readonly GithubListItem[]
): string {
  const lines: string[] = [`### Development progress for #${issueNumber}`, '']
  if (branches.length > 0) {
    lines.push(`**Branches:** ${branches.map((b) => `\`${b}\``).join(', ')}`)
  }
  if (prs.length > 0) {
    lines.push(`**Pull Requests:** ${prs.map((p) => `#${p.number} (${p.state})`).join(', ')}`)
  }
  if (commits.length > 0) {
    lines.push('', '**Commits:**')
    for (const c of commits.slice(0, 10)) {
      lines.push(`- \`${c.shortHash}\` ${c.subject}`)
    }
  }
  return lines.join('\n')
}

const STATUS_META: Record<IssueDevStatus, { label: string; badgeClass: string }> = {
  not_started: {
    label: 'Not started',
    badgeClass: 'bg-muted text-muted-foreground'
  },
  in_progress: {
    label: 'In progress',
    badgeClass: 'bg-primary/15 text-primary'
  },
  pr_open: {
    label: 'PR open',
    badgeClass: 'bg-diff-added/15 text-diff-added-foreground'
  },
  merged: {
    label: 'Merged',
    badgeClass: 'bg-diff-added/20 text-diff-added-foreground'
  }
}

interface GithubIssueDevelopmentProps {
  cwd: string
  repo: GithubRepoSlot
  issueNumber: number
  onPostProgressComment?: (body: string) => Promise<unknown>
}

/**
 * Development & Commits tracker for a GitHub issue: scans local git branches,
 * commit log (`--all`), and repository PRs to show whether work has started,
 * lets the user switch branches or open linked PRs, and can post a progress summary.
 */
export function GithubIssueDevelopment({
  cwd,
  repo,
  issueNumber,
  onPostProgressComment
}: GithubIssueDevelopmentProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [prs, setPrs] = useState<GithubListItem[]>([])
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null)
  const [postingProgress, setPostingProgress] = useState(false)

  const refresh = useCallback(async () => {
    if (!cwd) return
    setLoading(true)
    try {
      const [allBranches, commitCtx, allCommits, prListRes] = await Promise.all([
        typeof gitApi?.branchList === 'function'
          ? gitApi.branchList(cwd).catch(() => [])
          : Promise.resolve([]),
        typeof gitApi?.getCommitContext === 'function'
          ? gitApi.getCommitContext(cwd).catch(() => null)
          : Promise.resolve(null),
        typeof gitApi?.getLog === 'function'
          ? gitApi.getLog(cwd, 150, true).catch(() => [])
          : Promise.resolve([]),
        typeof githubApi?.listItems === 'function'
          ? githubApi
              .listItems({
                cwd,
                filter: {
                  ...DEFAULT_GITHUB_FILTER,
                  repo,
                  kind: 'pr',
                  state: 'all'
                }
              })
              .catch(() => null)
          : Promise.resolve(null)
      ])

      const matchedBranches = allBranches.filter((b) => branchMatchesIssue(b, issueNumber))
      const branchSet = new Set(matchedBranches)
      const matchedCommits = allCommits.filter((c) => commitMatchesIssue(c, issueNumber, branchSet))
      const matchedPrs =
        prListRes?.success && prListRes.data
          ? prListRes.data.items.filter((item) => prMatchesIssue(item, issueNumber))
          : []

      setCurrentBranch(commitCtx?.branch ?? null)
      setBranches(matchedBranches)
      setCommits(matchedCommits)
      setPrs(matchedPrs)
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'GithubIssueDevelopment',
        message: `Failed to scan issue #${issueNumber} development state: ${String(err)}`
      })
    } finally {
      setLoading(false)
    }
  }, [cwd, repo, issueNumber])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const status = computeIssueDevStatus(branches, commits, prs)
  const statusMeta = STATUS_META[status]
  const hasActivity = branches.length > 0 || commits.length > 0 || prs.length > 0

  const handleSwitchBranch = async (branch: string) => {
    setSwitchingBranch(branch)
    try {
      await useGitStatusStore.getState().branchSwitch(cwd, branch)
      setCurrentBranch(branch)
      toast.success(`Switched to ${branch}`)
    } catch (err) {
      toast.error(`Failed to switch branch: ${String(err)}`)
    } finally {
      setSwitchingBranch(null)
    }
  }

  const handleOpenPr = (pr: GithubListItem) => {
    useWorkspaceStore.getState().addGithubItemTab({
      cwd,
      repo,
      kind: 'pr',
      number: pr.number,
      title: pr.title
    })
  }

  const handlePostProgress = async () => {
    if (!onPostProgressComment || !hasActivity || postingProgress) return
    setPostingProgress(true)
    try {
      const body = buildProgressCommentMarkdown(issueNumber, branches, commits, prs)
      await onPostProgressComment(body)
      toast.success('Progress comment posted to issue')
    } catch (err) {
      toast.error(`Failed to post progress comment: ${String(err)}`)
    } finally {
      setPostingProgress(false)
    }
  }

  return (
    <section
      data-testid="issue-development-card"
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <span className="shrink-0 text-muted-foreground" aria-hidden="true">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <span className="font-semibold text-foreground">Development</span>
          <span
            data-testid="issue-dev-status"
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-3xs font-medium',
              statusMeta.badgeClass
            )}
          >
            {statusMeta.label}
          </span>
          <span className="truncate font-mono text-3xs text-muted-foreground">
            {branches.length} branch · {commits.length} commit · {prs.length} PR
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {hasActivity && onPostProgressComment && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={postingProgress}
              onClick={() => void handlePostProgress()}
              className="h-6 gap-1 px-2 text-3xs"
              title="Post a Markdown summary of linked branches, commits, and PRs as a comment"
            >
              <MessageSquare size={11} />
              {postingProgress ? 'Posting…' : 'Post progress'}
            </Button>
          )}
          <button
            type="button"
            aria-label="Refresh development status"
            title="Refresh development status"
            disabled={loading}
            onClick={() => void refresh()}
            className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-2.5 border-t border-border/60 px-3 py-2.5 text-xs">
          {loading && !hasActivity ? (
            <div className="flex items-center gap-2 text-2xs text-muted-foreground">
              <Spinner size={12} decorative />
              Checking local branches, commits, and pull requests…
            </div>
          ) : !hasActivity ? (
            <p className="text-2xs text-muted-foreground">
              No local branch, commit referencing <span className="font-mono">#{issueNumber}</span>,
              or linked PR detected yet. Click <strong>Start Branch</strong> above to begin.
            </p>
          ) : (
            <>
              {branches.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                    <GitBranch size={11} />
                    Branches ({branches.length})
                  </div>
                  <div className="space-y-1">
                    {branches.map((branch) => {
                      const active = branch === currentBranch
                      return (
                        <div
                          key={branch}
                          className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1"
                        >
                          <span className="truncate font-mono text-2xs text-foreground">
                            {branch}
                          </span>
                          {active ? (
                            <span className="shrink-0 rounded bg-diff-added/15 px-1.5 py-px text-3xs font-medium text-diff-added-foreground">
                              Current
                            </span>
                          ) : (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={switchingBranch !== null}
                              onClick={() => void handleSwitchBranch(branch)}
                              className="h-5 px-1.5 text-3xs"
                            >
                              {switchingBranch === branch ? 'Switching…' : 'Checkout'}
                            </Button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {prs.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                    <GitPullRequest size={11} />
                    Pull Requests ({prs.length})
                  </div>
                  <div className="space-y-1">
                    {prs.map((pr) => (
                      <button
                        key={pr.number}
                        type="button"
                        onClick={() => handleOpenPr(pr)}
                        className="flex w-full items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1 text-left transition-colors hover:bg-muted"
                      >
                        <span className="min-w-0 truncate text-2xs text-foreground">
                          <span className="font-mono text-muted-foreground">#{pr.number}</span>{' '}
                          {pr.title}
                        </span>
                        <span className="shrink-0 rounded bg-card px-1.5 py-px font-mono text-3xs uppercase text-secondary-foreground">
                          {pr.state}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {commits.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                    <GitCommitIcon size={11} />
                    Commits ({commits.length})
                  </div>
                  <div className="space-y-1">
                    {commits.slice(0, 8).map((commit) => (
                      <div
                        key={commit.hash}
                        data-testid={`issue-commit-${commit.shortHash}`}
                        className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="mr-1.5 font-mono text-3xs text-primary">
                            {commit.shortHash}
                          </span>
                          <span className="text-2xs text-foreground">{commit.subject}</span>
                        </div>
                        <span className="shrink-0 text-3xs text-muted-foreground">
                          {commit.author} · {relativeAgo(commit.date)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
