import type { GithubItemDetail, GithubLabel } from '@shared/types/github.types'
import { type LastSelectedAgent, PersistenceKeys } from '@shared/types/persistence.types'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { launchChat } from '@/components/agents/launcher/launch-chat'
import { openNewChat } from '@/components/chat/new-chat/open-new-chat'
import { seedComposerDraft } from '@/components/chat/use-composer-draft'
import { GitBranch } from '@/components/icons'
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
import type { ContentBlock } from '@/lib/acp-api'
import { persistenceApi } from '@/lib/api'
import { startIssuePrompt } from '@/lib/github-handoff/start'
import { renderHandoffPrompt } from '@/lib/github-handoff/untrusted'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { useGitStatusStore } from '@/stores/git-status-store'
import type { GithubItemRef } from '@/stores/github-store'

/** Build a clean git branch name like `fix/42-login-timeout` from an issue's labels and title. */
export function suggestIssueBranchName(
  number: number,
  title: string,
  labels: readonly Pick<GithubLabel, 'name'>[] = []
): string {
  const lowerLabels = labels.map((l) => l.name.toLowerCase())
  const lowerTitle = title.toLowerCase()

  let prefix = 'issue'
  if (
    lowerLabels.some((l) => l.includes('bug') || l.includes('fix') || l.includes('hotfix')) ||
    /\b(fix|bug|error|crash|broken)\b/.test(lowerTitle)
  ) {
    prefix = 'fix'
  } else if (
    lowerLabels.some((l) => l.includes('feat') || l.includes('enhancement')) ||
    /\b(add|feat|feature|support|implement)\b/.test(lowerTitle)
  ) {
    prefix = 'feat'
  } else if (lowerLabels.some((l) => l.includes('doc'))) {
    prefix = 'docs'
  } else if (lowerLabels.some((l) => l.includes('refactor'))) {
    prefix = 'refactor'
  }

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44)
    .replace(/-+$/, '')

  return slug ? `${prefix}/${number}-${slug}` : `${prefix}/${number}`
}

async function resolveAgentConfigId(): Promise<string | null> {
  const configs = useAcpStore.getState().agentConfigs
  if (configs.length === 0) return null
  const saved = await persistenceApi
    .read<LastSelectedAgent>(PersistenceKeys.lastSelectedAgent)
    .catch(() => null)
  const savedId = saved?.success && saved.data?.mode === 'acp' ? saved.data.agentId : null
  return configs.find((config) => config.id === savedId)?.id ?? configs[0].id
}

interface StartIssueBranchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  itemRef: GithubItemRef
  detail: GithubItemDetail
}

export function StartIssueBranchDialog({
  open,
  onOpenChange,
  projectId,
  itemRef,
  detail
}: StartIssueBranchDialogProps): React.JSX.Element {
  const [branchName, setBranchName] = useState('')
  const [autoSend, setAutoSend] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setBranchName(suggestIssueBranchName(detail.item.number, detail.item.title, detail.item.labels))
    setAutoSend(false)
    setError(null)
  }, [open, detail.item.number, detail.item.title, detail.item.labels])

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmed = branchName.trim()
    if (!trimmed || /\s/.test(trimmed)) {
      setError('Enter a valid branch name without spaces.')
      return
    }

    setRunning(true)
    setError(null)
    try {
      await useGitStatusStore.getState().branchCreate(itemRef.cwd, trimmed)
      toast.success(`Switched to new branch ${trimmed}`)

      const configId = await resolveAgentConfigId()
      const prompt = renderHandoffPrompt(startIssuePrompt(detail))
      if (!configId) {
        toast.info('Branch created. Select an AI agent to start working on this issue.')
        void openNewChat({ projectId, reason: 'github-handoff' })
        onOpenChange(false)
        return
      }

      const initialBlocks: ContentBlock[] | null = autoSend
        ? [{ type: 'text', text: prompt }]
        : null
      let draftSeeded = false
      const seedDraft = (sessionId: string): void => {
        if (autoSend || draftSeeded) return
        draftSeeded = true
        seedComposerDraft(projectId, sessionId, prompt)
      }

      const { started } = launchChat({
        configId,
        projectId,
        surface: { kind: 'pane' },
        checkout: { launchCwd: itemRef.cwd },
        placeholder: initialBlocks ? { initialUserBlocks: initialBlocks } : undefined,
        beforeStart: initialBlocks ? async () => ({ blocks: initialBlocks }) : undefined,
        onAdopt: (_from, to) => seedDraft(to)
      })
      const sessionId = await started
      seedDraft(sessionId)
      onOpenChange(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      void logFrontendError({
        level: 'warn',
        source: 'StartIssueBranchDialog',
        message: `Start branch failed for #${detail.item.number}: ${msg}`
      })
      setError(msg)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <GitBranch size={15} />
            Start Branch from Issue #{detail.item.number}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Creates and checks out a new branch directly in this repo, then opens an AI Chat with
            the issue context.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Repository folder</Label>
            <div className="truncate rounded-md border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-2xs text-foreground">
              {itemRef.cwd}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="issue-branch-name" className="text-xs">
              New branch name
            </Label>
            <Input
              id="issue-branch-name"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="fix/42-issue-slug"
              className="h-8 font-mono text-xs"
              required
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-secondary-foreground select-none">
            <input
              type="checkbox"
              checked={autoSend}
              onChange={(e) => setAutoSend(e.target.checked)}
              className="size-3.5 accent-foreground"
            />
            Auto-send prompt to AI immediately
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
              disabled={running}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="default" disabled={running}>
              {running ? 'Starting…' : 'Create branch & open Chat'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
