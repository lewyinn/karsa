import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { baseName } from '@/components/chat/tool-call-summary'
import { MaterialFileIcon } from '@/components/file-explorer/MaterialFileIcon'
import { ChevronDown, ChevronRight, FileDiff, Minus, Plus, Undo2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Spinner } from '@/components/ui/spinner'
import type { DiffContent, ToolCall } from '@/lib/acp-api'
import { gitApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useGitStatusStore } from '@/stores/git-status-store'
import { DiffRows, useDiffHighlight } from './DiffPreview'
import { diffLines } from './tool-call-format'
import { type ChangedFile, type ChatChangedFiles, dirName } from './use-chat-changed-files'

interface ParsedUnifiedLine {
  kind: 'hunk' | 'added' | 'removed' | 'context'
  oldLine?: number
  newLine?: number
  text: string
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Parse a git unified diff string into displayable rows with line numbers. */
export function parseUnifiedDiff(raw: string): ParsedUnifiedLine[] {
  const out: ParsedUnifiedLine[] = []
  let oldNum = 0
  let newNum = 0
  let inHunk = false

  for (const line of raw.split(/\r?\n/)) {
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      continue
    }
    const hunk = HUNK_HEADER_RE.exec(line)
    if (hunk) {
      oldNum = Number.parseInt(hunk[1], 10)
      newNum = Number.parseInt(hunk[2], 10)
      inHunk = true
      out.push({ kind: 'hunk', text: line })
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) {
      out.push({ kind: 'added', newLine: newNum, text: line.slice(1) })
      newNum += 1
    } else if (line.startsWith('-')) {
      out.push({ kind: 'removed', oldLine: oldNum, text: line.slice(1) })
      oldNum += 1
    } else if (line.startsWith(' ')) {
      out.push({ kind: 'context', oldLine: oldNum, newLine: newNum, text: line.slice(1) })
      oldNum += 1
      newNum += 1
    } else if (line.startsWith('\\')) {
      out.push({ kind: 'context', text: line })
    }
  }
  return out
}

function repoRelativePath(fullPath: string, root: string): string {
  const normalizedFull = fullPath.replace(/\\/g, '/')
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedRoot) return normalizedFull
  const prefix = `${normalizedRoot}/`
  return normalizedFull.startsWith(prefix) ? normalizedFull.slice(prefix.length) : normalizedFull
}

function findToolCallDiff(toolCalls: readonly ToolCall[], fullPath: string): DiffContent | null {
  const target = fullPath.replace(/\\/g, '/').toLowerCase()
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    const content = toolCalls[i]?.content
    if (!content) continue
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const item = content[j]
      if (
        item.type !== 'diff' ||
        typeof item.path !== 'string' ||
        typeof item.newText !== 'string'
      ) {
        continue
      }
      const itemPath = item.path.replace(/\\/g, '/').toLowerCase()
      if (itemPath === target || target.endsWith(`/${itemPath}`)) {
        return {
          path: item.path,
          oldText: typeof item.oldText === 'string' ? item.oldText : null,
          newText: item.newText
        }
      }
    }
  }
  return null
}

function ToolCallInlineDiff({ diff }: { diff: DiffContent }): React.JSX.Element {
  const lines = useMemo(() => diffLines(diff), [diff])
  const highlight = useDiffHighlight(diff.path, diff.oldText, diff.newText)
  return (
    <div className="scroller-thin max-h-72 overflow-auto overscroll-contain bg-background/60 p-2 font-mono text-2xs leading-relaxed">
      <DiffRows lines={lines} highlight={highlight} />
    </div>
  )
}

function UnifiedInlineDiff({ raw }: { raw: string }): React.JSX.Element {
  const lines = useMemo(() => parseUnifiedDiff(raw), [raw])
  if (lines.length === 0) {
    return (
      <div className="px-3 py-2 text-2xs text-muted-foreground">
        No textual diff available for this file.
      </div>
    )
  }
  return (
    <div className="scroller-thin max-h-72 overflow-auto overscroll-contain bg-background/60 py-1.5 font-mono text-2xs leading-relaxed">
      {lines.map((line, index) => {
        if (line.kind === 'hunk') {
          return (
            <div
              key={index}
              className="select-none bg-muted/40 px-3 py-0.5 text-3xs text-muted-foreground"
            >
              {line.text}
            </div>
          )
        }
        const lineNum = line.newLine ?? line.oldLine
        return (
          <div
            key={index}
            className={cn(
              'flex px-2',
              line.kind === 'added' && 'bg-diff-added/10 text-diff-added-foreground',
              line.kind === 'removed' && 'bg-destructive/10 text-destructive',
              line.kind === 'context' && 'text-muted-foreground'
            )}
          >
            <span className="w-9 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground/50">
              {lineNum ?? ''}
            </span>
            <span className="w-4 shrink-0 select-none opacity-65">
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{line.text}</span>
          </div>
        )
      })}
    </div>
  )
}

interface DiffEntryState {
  key: string
  status: 'loading' | 'ready' | 'error'
  raw?: string
  error?: string
}

interface FileDiffRowProps {
  file: ChangedFile
  rowBase: string
  diffRoot: string
  source: ChatChangedFiles['source']
  toolCalls: readonly ToolCall[]
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onToggleStage: (
    file: ChangedFile,
    repoRoot: string,
    relPath: string,
    shouldStage: boolean
  ) => void
  onRequestRevert: (file: ChangedFile, repoRoot: string, relPath: string) => void
}

function FileDiffRow({
  file,
  rowBase,
  diffRoot,
  source,
  toolCalls,
  expanded,
  busy,
  onToggle,
  onToggleStage,
  onRequestRevert
}: FileDiffRowProps): React.JSX.Element {
  const label = baseName(file.path) || file.path
  const dir = dirName(file.path, rowBase)
  const effectiveDiffRoot = file.repoRoot ?? diffRoot
  const relPath = repoRelativePath(file.path, effectiveDiffRoot)
  const isFullyStaged = Boolean(file.staged && !file.hasUnstaged)
  const canGitMutate = source === 'git' && Boolean(effectiveDiffRoot)
  const diffKey = `${effectiveDiffRoot}:${file.path}:${file.added}:${file.removed}:${file.status ?? ''}`
  const [diffState, setDiffState] = useState<DiffEntryState | null>(null)
  const loadedKeyRef = useRef<string | null>(null)
  const fallbackToolDiff = useMemo(
    () => (expanded ? findToolCallDiff(toolCalls, file.path) : null),
    [expanded, toolCalls, file.path]
  )

  useEffect(() => {
    if (!expanded) return
    if (source !== 'git' || !effectiveDiffRoot) return
    if (loadedKeyRef.current === diffKey) return

    let cancelled = false
    let finished = false
    loadedKeyRef.current = diffKey
    setDiffState({ key: diffKey, status: 'loading' })
    const relPath = repoRelativePath(file.path, effectiveDiffRoot)

    void (async () => {
      try {
        let raw = await gitApi.getDiff(effectiveDiffRoot, relPath, false)
        if (!raw.trim()) {
          raw = await gitApi.getDiff(effectiveDiffRoot, relPath, true)
        }
        if (cancelled) return
        finished = true
        setDiffState({ key: diffKey, status: 'ready', raw })
      } catch (err) {
        if (cancelled) return
        loadedKeyRef.current = null
        const message = err instanceof Error ? err.message : String(err)
        void logFrontendError({
          level: 'warn',
          source: 'ChangedFilesCard',
          message: `Failed to load inline diff for ${relPath}: ${message}`
        })
        setDiffState({ key: diffKey, status: 'error', error: message })
      }
    })()

    return () => {
      cancelled = true
      if (!finished && loadedKeyRef.current === diffKey) {
        loadedKeyRef.current = null
      }
    }
  }, [expanded, diffKey, source, effectiveDiffRoot, file.path])

  const hasGitDiff = diffState?.status === 'ready' && Boolean(diffState.raw?.trim())

  return (
    <div className="border-t border-border/50 first:border-t-0">
      <div className="group flex min-h-8 items-center gap-1 pr-2 transition-colors hover:bg-foreground/[0.03]">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          data-testid={`changed-file-row-${label}`}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 pr-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
        >
          <span className="shrink-0 text-muted-foreground/70" aria-hidden="true">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <MaterialFileIcon
            name={label}
            isDirectory={false}
            isExpanded={false}
            depth={0}
            size={14}
          />
          <span
            className={cn(
              'shrink-0 font-medium',
              file.status === 'deleted' ? 'text-muted-foreground line-through' : 'text-foreground'
            )}
          >
            {label}
          </span>
          {file.repoLabel && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-3xs text-secondary-foreground">
              {file.repoLabel}
            </span>
          )}
          {isFullyStaged && (
            <span className="shrink-0 rounded bg-diff-added/15 px-1.5 py-px text-3xs font-medium text-diff-added-foreground">
              Staged
            </span>
          )}
          {dir && <span className="min-w-0 flex-1 truncate text-muted-foreground">{dir}</span>}
          {!dir && <span className="flex-1" />}
          <span className="shrink-0 font-mono text-xs tabular-nums">
            <span className="text-diff-added-foreground">+{file.added}</span>{' '}
            <span className="text-destructive">-{file.removed}</span>
          </span>
        </button>

        {canGitMutate && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              disabled={busy}
              aria-label={isFullyStaged ? `Unstage ${label}` : `Stage ${label}`}
              title={isFullyStaged ? `Unstage ${label}` : `Stage ${label}`}
              onClick={() => onToggleStage(file, effectiveDiffRoot, relPath, !isFullyStaged)}
              className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {isFullyStaged ? <Minus size={12} /> : <Plus size={12} />}
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label={`Revert ${label}`}
              title={`Discard changes in ${label}`}
              onClick={() => onRequestRevert(file, effectiveDiffRoot, relPath)}
              className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Undo2 size={12} />
            </button>
          </div>
        )}
      </div>

      <CollapseExpandMotion open={expanded}>
        <div className="border-t border-border/40" data-testid={`changed-file-diff-${label}`}>
          {diffState?.status === 'loading' && !fallbackToolDiff ? (
            <div className="flex items-center gap-2 px-3 py-2 text-2xs text-muted-foreground">
              <Spinner size={12} decorative />
              Loading diff…
            </div>
          ) : hasGitDiff && diffState?.raw ? (
            <UnifiedInlineDiff raw={diffState.raw} />
          ) : fallbackToolDiff ? (
            <ToolCallInlineDiff diff={fallbackToolDiff} />
          ) : diffState?.status === 'error' ? (
            <div className="px-3 py-2 text-2xs text-destructive">
              Could not load diff: {diffState.error}
            </div>
          ) : (
            <div className="px-3 py-2 text-2xs text-muted-foreground">
              {file.status === 'untracked'
                ? 'New untracked file (no git diff yet).'
                : file.status === 'deleted'
                  ? 'File deleted.'
                  : 'No diff lines to preview.'}
            </div>
          )}
        </div>
      </CollapseExpandMotion>
    </div>
  )
}

export interface ChangedFilesCardProps {
  changes: ChatChangedFiles
  cwd: string
  toolCalls: readonly ToolCall[]
  className?: string
}

/**
 * Inline collapsible "N files changed +X -Y" summary card above the chat composer.
 * Clicking the header expands the file list downward, and clicking any file row
 * drops its diff open inline downward without opening a side panel.
 */
interface RevertTarget {
  file: ChangedFile
  repoRoot: string
  relPath: string
}

export function ChangedFilesCard({
  changes,
  cwd,
  toolCalls,
  className
}: ChangedFilesCardProps): React.JSX.Element | null {
  const [listOpen, setListOpen] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [revertTarget, setRevertTarget] = useState<RevertTarget | null>(null)

  const files = changes.files
  const { totalAdded, totalRemoved, rowBase } = changes
  const diffRoot = rowBase || cwd

  const toggleFile = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleToggleStage = useCallback(
    async (file: ChangedFile, repoRoot: string, relPath: string, shouldStage: boolean) => {
      const label = baseName(file.path) || relPath
      setBusyPath(file.path)
      try {
        const store = useGitStatusStore.getState()
        if (shouldStage) {
          await store.stageFiles(repoRoot, [relPath])
          toast.success(`Staged ${label}`)
        } else {
          await store.unstageFiles(repoRoot, [relPath])
          toast.success(`Unstaged ${label}`)
        }
        void store.refreshDiffStat(repoRoot)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        void logFrontendError({
          level: 'warn',
          source: 'ChangedFilesCard',
          message: `Failed to ${shouldStage ? 'stage' : 'unstage'} ${relPath}: ${message}`
        })
        toast.error(`Failed to ${shouldStage ? 'stage' : 'unstage'} ${label}: ${message}`)
      } finally {
        setBusyPath(null)
      }
    },
    []
  )

  const handleRequestRevert = useCallback(
    (file: ChangedFile, repoRoot: string, relPath: string) => {
      setRevertTarget({ file, repoRoot, relPath })
    },
    []
  )

  const handleConfirmRevert = useCallback(async () => {
    if (!revertTarget) return
    const { file, repoRoot, relPath } = revertTarget
    const label = baseName(file.path) || relPath
    setBusyPath(file.path)
    try {
      const store = useGitStatusStore.getState()
      await store.discardFiles(repoRoot, [relPath])
      void store.refreshDiffStat(repoRoot)
      setExpandedPaths((prev) => {
        if (!prev.has(file.path)) return prev
        const next = new Set(prev)
        next.delete(file.path)
        return next
      })
      toast.success(`Reverted ${label}`)
      setRevertTarget(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      void logFrontendError({
        level: 'warn',
        source: 'ChangedFilesCard',
        message: `Failed to discard ${relPath}: ${message}`
      })
      toast.error(`Failed to revert ${label}: ${message}`)
    } finally {
      setBusyPath(null)
    }
  }, [revertTarget])

  const allFilesExpanded = files.length > 0 && files.every((f) => expandedPaths.has(f.path))

  const handleReviewToggle = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      if (listOpen && allFilesExpanded) {
        setExpandedPaths(new Set())
        setListOpen(false)
        return
      }
      setListOpen(true)
      setExpandedPaths(new Set(files.map((f) => f.path)))
    },
    [listOpen, allFilesExpanded, files]
  )

  if (files.length === 0) return null

  const fileCountLabel = `${files.length} ${files.length === 1 ? 'file' : 'files'} changed`
  const revertLabel = revertTarget ? baseName(revertTarget.file.path) || revertTarget.relPath : ''
  const revertMessage = revertTarget
    ? revertTarget.file.status === 'untracked'
      ? `Delete the new untracked file "${revertTarget.relPath}"? This cannot be undone.`
      : `Discard all uncommitted changes in "${revertTarget.relPath}"? This cannot be undone.`
    : ''

  return (
    <div
      data-testid="changed-files-card"
      className={cn('overflow-hidden rounded-lg border border-border bg-card shadow-xs', className)}
    >
      <div className="flex min-h-9 items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          aria-expanded={listOpen}
          onClick={() => setListOpen((prev) => !prev)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <span className="font-medium text-foreground">{fileCountLabel}</span>
          <span className="font-mono text-xs tabular-nums">
            <span className="text-diff-added-foreground">+{totalAdded}</span>{' '}
            <span className="text-destructive">-{totalRemoved}</span>
          </span>
          <ChevronDown
            size={13}
            aria-hidden="true"
            className={cn(
              'shrink-0 text-muted-foreground transition-transform duration-150',
              listOpen && 'rotate-180'
            )}
          />
        </button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={handleReviewToggle}
          aria-pressed={listOpen && allFilesExpanded}
        >
          <FileDiff size={12} />
          {listOpen && allFilesExpanded ? 'Hide diffs' : 'Review'}
        </Button>
      </div>

      <CollapseExpandMotion open={listOpen}>
        <div
          className="scroller-thin max-h-96 overflow-y-auto overscroll-contain border-t border-border/60"
          data-testid="changed-files-card-list"
        >
          {files.map((file) => (
            <FileDiffRow
              key={file.path}
              file={file}
              rowBase={rowBase}
              diffRoot={diffRoot}
              source={changes.source}
              toolCalls={toolCalls}
              expanded={expandedPaths.has(file.path)}
              busy={busyPath === file.path}
              onToggle={() => toggleFile(file.path)}
              onToggleStage={(f, root, rel, shouldStage) =>
                void handleToggleStage(f, root, rel, shouldStage)
              }
              onRequestRevert={handleRequestRevert}
            />
          ))}
        </div>
      </CollapseExpandMotion>

      <ConfirmDialog
        isOpen={revertTarget !== null}
        title={`Revert ${revertLabel}?`}
        message={revertMessage}
        confirmLabel={revertTarget?.file.status === 'untracked' ? 'Delete file' : 'Discard changes'}
        variant="danger"
        isLoading={revertTarget !== null && busyPath === revertTarget.file.path}
        onConfirm={() => void handleConfirmRevert()}
        onCancel={() => {
          if (busyPath === null) setRevertTarget(null)
        }}
      />
    </div>
  )
}
