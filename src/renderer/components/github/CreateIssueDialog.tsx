import type { GithubRepoMeta, GithubRepoSlot } from '@shared/types/github.types'
import type { DiscoveredGitRepo } from '@shared/types/ipc.types'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, FolderGit2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { githubApi } from '@/lib/github-api'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { LabelChip } from './github-status'

export interface CreatedIssueOutcome {
  cwd: string
  repo: GithubRepoSlot
  number: number
  title: string
  url: string
}

export interface CreateIssueDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultCwd: string
  defaultRepoSlot?: GithubRepoSlot
  repos?: readonly DiscoveredGitRepo[]
  onCreated: (created: CreatedIssueOutcome) => void
}

/**
 * Dialog to file a new GitHub issue via `gh` CLI. Supports multi-repo
 * workspaces by letting the user switch the target repository right in the form.
 */
export function CreateIssueDialog({
  open,
  onOpenChange,
  defaultCwd,
  defaultRepoSlot = 'origin',
  repos = [],
  onCreated
}: CreateIssueDialogProps): React.JSX.Element {
  const showRepoPicker = repos.length > 1 || (repos.length === 1 && !repos[0].isRoot)
  const [targetCwd, setTargetCwd] = useState(defaultCwd)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [selectedLabels, setSelectedLabels] = useState<string[]>([])
  const [selectedAssignees, setSelectedAssignees] = useState<string[]>([])
  const [meta, setMeta] = useState<GithubRepoMeta | null>(null)
  const [loadingMeta, setLoadingMeta] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const nextCwd = defaultCwd || repos[0]?.path || ''
    setTargetCwd(nextCwd)
    setTitle('')
    setBody('')
    setSelectedLabels([])
    setSelectedAssignees([])
    setError(null)
  }, [open, defaultCwd, repos])

  useEffect(() => {
    if (!open || !targetCwd) return
    let cancelled = false
    setLoadingMeta(true)
    setMeta(null)
    void githubApi
      .getRepoMeta({ cwd: targetCwd, repo: defaultRepoSlot })
      .then((res) => {
        if (cancelled) return
        setMeta(res.success ? res.data : null)
      })
      .finally(() => {
        if (!cancelled) setLoadingMeta(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, targetCwd, defaultRepoSlot])

  const handleTargetRepoChange = (nextPath: string): void => {
    setTargetCwd(nextPath)
    setSelectedLabels([])
    setSelectedAssignees([])
    setError(null)
  }

  const toggleLabel = (name: string): void => {
    setSelectedLabels((prev) =>
      prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]
    )
  }

  const toggleAssignee = (login: string): void => {
    setSelectedAssignees((prev) =>
      prev.includes(login) ? prev.filter((item) => item !== login) : [...prev, login]
    )
  }

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    if (!trimmedTitle || !targetCwd || submitting) return

    setSubmitting(true)
    setError(null)
    try {
      const result = await githubApi.createIssue({
        cwd: targetCwd,
        repo: defaultRepoSlot,
        title: trimmedTitle,
        body,
        labels: selectedLabels,
        assignees: selectedAssignees
      })
      if (!result.success) {
        setError(result.error || 'Could not create issue')
        return
      }
      void logFrontendError({
        level: 'info',
        source: 'CreateIssueDialog',
        message: `Created GitHub issue #${result.data.number} in ${targetCwd}`
      })
      toast.success(`Created issue #${result.data.number}`)
      onOpenChange(false)
      onCreated({
        cwd: targetCwd,
        repo: defaultRepoSlot,
        number: result.data.number,
        title: result.data.title,
        url: result.data.url
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const repoDisplayName = meta ? `${meta.repo.owner}/${meta.repo.name}` : null

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
            <DialogDescription>
              {repoDisplayName
                ? `Create a GitHub issue in ${repoDisplayName}.`
                : 'Create a new GitHub issue in this repository.'}
            </DialogDescription>
          </DialogHeader>

          {showRepoPicker && (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="create-issue-repo"
                className="text-xs font-medium text-secondary-foreground"
              >
                Repository
              </label>
              <Select
                value={targetCwd}
                onValueChange={handleTargetRepoChange}
                disabled={submitting}
              >
                <SelectTrigger
                  id="create-issue-repo"
                  aria-label="Target repository"
                  className="h-8 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <FolderGit2
                      size={13}
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground"
                    />
                    <SelectValue placeholder="Choose repository" />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {repos.map((repo) => (
                    <SelectItem key={repo.path} value={repo.path}>
                      {repo.isRoot ? `${repo.name} (root)` : repo.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="create-issue-title"
              className="text-xs font-medium text-secondary-foreground"
            >
              Title
            </label>
            <Input
              id="create-issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary of the bug or task"
              disabled={submitting}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="create-issue-body"
              className="text-xs font-medium text-secondary-foreground"
            >
              Description
            </label>
            <textarea
              id="create-issue-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Add details, steps to reproduce, or acceptance criteria (Markdown supported)"
              rows={5}
              disabled={submitting}
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60"
            />
          </div>

          {loadingMeta ? (
            <div className="flex items-center gap-2 text-2xs text-muted-foreground">
              <Spinner size={12} decorative />
              Loading labels and assignees…
            </div>
          ) : meta ? (
            <div className="flex flex-col gap-3">
              {meta.labels.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-secondary-foreground">Labels</span>
                  <div className="scroller-thin flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                    {meta.labels.map((label) => {
                      const active = selectedLabels.includes(label.name)
                      return (
                        <button
                          key={label.name}
                          type="button"
                          aria-pressed={active}
                          disabled={submitting}
                          onClick={() => toggleLabel(label.name)}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border p-0.5 transition-colors',
                            active
                              ? 'border-foreground/40 bg-foreground/[0.06]'
                              : 'border-transparent opacity-75 hover:opacity-100'
                          )}
                        >
                          <LabelChip label={label} />
                          {active && <Check size={11} className="mr-1 text-foreground" />}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {meta.assignableUsers.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-secondary-foreground">Assignees</span>
                    {meta.viewer && !selectedAssignees.includes(meta.viewer) && (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => toggleAssignee(meta.viewer)}
                        className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        Assign to me (@{meta.viewer})
                      </button>
                    )}
                  </div>
                  <div className="scroller-thin flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
                    {meta.assignableUsers.slice(0, 20).map((login) => {
                      const active = selectedAssignees.includes(login)
                      return (
                        <button
                          key={login}
                          type="button"
                          aria-pressed={active}
                          disabled={submitting}
                          onClick={() => toggleAssignee(login)}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-2xs transition-colors',
                            active
                              ? 'border-foreground/40 bg-foreground/[0.08] font-medium text-foreground'
                              : 'border-border bg-background text-muted-foreground hover:text-foreground'
                          )}
                        >
                          {active && <Check size={10} />}@{login}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={submitting || title.trim().length === 0 || !targetCwd}
            >
              {submitting ? 'Creating…' : 'Create issue'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
