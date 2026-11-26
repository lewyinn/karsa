import type { GithubRepoSlot } from '@shared/types/github.types'
import type { DiscoveredGitRepo } from '@shared/types/ipc.types'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { GitPullRequest, Sparkles } from '@/components/icons'
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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { gitApi } from '@/lib/api'
import { githubApi } from '@/lib/github-api'
import { logFrontendError } from '@/lib/log-api'
import { worktreeApi } from '@/lib/worktree-api'
import { useAcpStore } from '@/stores/acp-store'

export interface CreatedPrOutcome {
  cwd: string
  repo: GithubRepoSlot
  number: number
  title: string
  url: string
}

interface CreatePrDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultCwd: string
  defaultRepoSlot?: GithubRepoSlot
  repos: readonly DiscoveredGitRepo[]
  onCreated: (outcome: CreatedPrOutcome) => void
}

export function CreatePrDialog({
  open,
  onOpenChange,
  defaultCwd,
  defaultRepoSlot = 'origin',
  repos,
  onCreated
}: CreatePrDialogProps): React.JSX.Element {
  const [targetCwd, setTargetCwd] = useState(defaultCwd)
  const [head, setHead] = useState('')
  const [base, setBase] = useState('main')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedAgentConfigId = useAcpStore((s) => s.selectedAgentConfigId)
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const hasUsableAgent =
    selectedAgentConfigId !== null &&
    agentConfigs.some((config) => config.id === selectedAgentConfigId)

  useEffect(() => {
    if (!open) return
    const initialCwd =
      repos.find((r) => r.path === defaultCwd)?.path ?? repos[0]?.path ?? defaultCwd
    setTargetCwd(initialCwd)
    setTitle('')
    setBody('')
    setDraft(false)
    setError(null)
  }, [open, defaultCwd, repos])

  useEffect(() => {
    if (!open || !targetCwd) return
    let cancelled = false
    void (async () => {
      const [ctx, baseRes] = await Promise.all([
        gitApi.getCommitContext(targetCwd).catch(() => null),
        worktreeApi.resolveBaseBranch(targetCwd).catch(() => null)
      ])
      if (cancelled) return
      if (ctx?.branch) setHead(ctx.branch)
      if (baseRes?.success && baseRes.data?.defaultBase) {
        setBase(baseRes.data.defaultBase)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, targetCwd])

  const handleGenerateWithAi = async (): Promise<void> => {
    if (!targetCwd || generating) return
    if (!hasUsableAgent) {
      toast.error('Configure and select an ACP agent before generating a PR draft')
      return
    }
    setGenerating(true)
    setError(null)
    try {
      const commits = await gitApi.getLog(targetCwd, 12).catch(() => [])
      const commitLines = commits
        .slice(0, 12)
        .map((c) => `- ${c.shortHash ?? c.hash.slice(0, 7)} ${c.subject}`)
        .join('\n')
      const contextPayload = [
        `PULL REQUEST DRAFT CONTEXT (${head || 'current-branch'} -> ${base || 'main'})`,
        'Return JSON {"summary":"PR title <= 72 chars","description":"Markdown PR body with ## Summary and bullet points"}.',
        'Recent commits:',
        commitLines || '(no recent commits read)'
      ].join('\n')

      const generated = await useAcpStore
        .getState()
        .generateCommitMessage(targetCwd, contextPayload)
      setTitle(generated.summary)
      setBody(generated.description)
      toast.success('PR title & description generated')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      void logFrontendError({
        level: 'warn',
        source: 'CreatePrDialog',
        message: `AI PR draft failed: ${msg}`
      })
      toast.error(msg)
    } finally {
      setGenerating(false)
    }
  }

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    const trimmedHead = head.trim()
    const trimmedBase = base.trim()
    if (!trimmedTitle) {
      setError('Pull request title is required.')
      return
    }
    if (!trimmedHead || !trimmedBase) {
      setError('Both source (head) and target (base) branches are required.')
      return
    }
    if (trimmedHead === trimmedBase) {
      setError('Head and base branches must be different.')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const res = await githubApi.createPr({
        cwd: targetCwd,
        repo: defaultRepoSlot,
        title: trimmedTitle,
        body: body.trimEnd(),
        head: trimmedHead,
        base: trimmedBase,
        draft
      })
      if (!res.success) {
        const msg = res.error || 'Failed to create pull request'
        setError(msg)
        void logFrontendError({
          level: 'warn',
          source: 'CreatePrDialog',
          message: `createPr failed: ${msg}`
        })
        return
      }
      const created = res.data
      toast.success(`Created PR #${created.number}`)
      onCreated({
        cwd: targetCwd,
        repo: defaultRepoSlot,
        number: created.number,
        title: created.title,
        url: created.url
      })
      onOpenChange(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <GitPullRequest size={15} />
            Create Pull Request
          </DialogTitle>
          <DialogDescription className="text-xs">
            Open a pull request on GitHub from your pushed branch.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          {repos.length > 1 && (
            <div className="space-y-1">
              <Label htmlFor="create-pr-repo" className="text-xs">
                Target Repository
              </Label>
              <Select value={targetCwd} onValueChange={setTargetCwd}>
                <SelectTrigger
                  id="create-pr-repo"
                  aria-label="Target Repository"
                  className="h-8 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {repos.map((repo) => (
                    <SelectItem key={repo.path} value={repo.path}>
                      {repo.isRoot ? repo.name : repo.relativePath}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="create-pr-head" className="text-xs">
                Head branch (from)
              </Label>
              <Input
                id="create-pr-head"
                value={head}
                onChange={(e) => setHead(e.target.value)}
                placeholder="feat/my-branch"
                className="h-8 font-mono text-xs"
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-pr-base" className="text-xs">
                Base branch (into)
              </Label>
              <Input
                id="create-pr-base"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="main"
                className="h-8 font-mono text-xs"
                required
              />
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="create-pr-title" className="text-xs">
                Title
              </Label>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={generating || submitting}
                onClick={() => void handleGenerateWithAi()}
                className="h-6 gap-1 px-2 text-2xs"
              >
                {generating ? <Spinner size={11} decorative /> : <Sparkles size={11} />}
                {generating ? 'Generating…' : 'Generate with AI'}
              </Button>
            </div>
            <Input
              id="create-pr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="feat: concise pull request title"
              className="h-8 text-xs"
              required
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="create-pr-body" className="text-xs">
              Description (Markdown)
            </Label>
            <textarea
              id="create-pr-body"
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="## Summary&#10;- Describe what changed and why"
              className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-secondary-foreground select-none">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              className="size-3.5 accent-foreground"
            />
            Create as draft pull request
          </label>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="default" disabled={submitting || generating}>
              {submitting ? 'Creating…' : 'Create PR'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
