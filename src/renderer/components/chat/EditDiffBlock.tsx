import { useMemo, useState } from 'react'
import { MaterialFileIcon } from '@/components/file-explorer/MaterialFileIcon'
import { AlertCircle, ChevronRight, ExternalLink } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { ShimmerText } from '@/components/ui/shimmer-text'
import type { DiffContent } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { DiffRows, useDiffHighlight } from './DiffPreview'
import { diffLines, firstChange } from './tool-call-format'
import { baseName } from './tool-call-summary'

/** Rows the collapsed preview shows before the fade. */
export const COLLAPSED_ROWS = 4

interface EditDiffBlockProps {
  diff: DiffContent
  running?: boolean
  failed?: boolean
  /** Open `path` in the editor at the 1-based `line`; absent omits the open button. */
  onOpenFile?: (path: string, line: number) => void
}

/**
 * Inline edit result: a collapsible file header (click toggles the diff body
 * open/closed, with an ExternalLink button to jump straight to the edited line)
 * over a few diff rows that fade out; a click on the rows expands them to the
 * full scrollable diff.
 */
export function EditDiffBlock({
  diff,
  running = false,
  failed = false,
  onOpenFile
}: EditDiffBlockProps): React.JSX.Element {
  const lines = useMemo(
    () => diffLines({ oldText: diff.oldText, newText: diff.newText }),
    [diff.oldText, diff.newText]
  )
  const { added, removed } = useMemo(() => {
    let a = 0
    let r = 0
    for (const line of lines) {
      if (line.type === 'added') a++
      else if (line.type === 'removed') r++
    }
    return { added: a, removed: r }
  }, [lines])
  const change = useMemo(() => firstChange(lines), [lines])
  const highlight = useDiffHighlight(diff.path, diff.oldText, diff.newText)
  const [bodyOpen, setBodyOpen] = useState(true)
  const [expanded, setExpanded] = useState(false)

  const name = baseName(diff.path)
  const start = change ? Math.max(0, change.index - 1) : 0
  const hasMoreBelow = lines.length > start + COLLAPSED_ROWS
  const collapsible = start > 0 || hasMoreBelow
  const collapsed = collapsible && !expanded
  const visible = collapsed ? lines.slice(start, start + COLLAPSED_ROWS) : lines
  const openLine = change?.line ?? 1
  const hasLines = lines.length > 0

  const headerLabel = (
    <>
      {hasLines && (
        <ChevronRight
          size={12}
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-150',
            bodyOpen && 'rotate-90'
          )}
        />
      )}
      <MaterialFileIcon name={name} isDirectory={false} isExpanded={false} depth={0} size={14} />
      <span
        className={cn('min-w-0 truncate', failed ? 'text-destructive' : 'text-foreground')}
        title={diff.path}
      >
        {running ? <ShimmerText text={name} /> : name}
      </span>
      <span className="shrink-0 text-2xs tabular-nums">
        <span className="text-success">+{added}</span>
        {removed > 0 && <span className="text-destructive"> &minus;{removed}</span>}
      </span>
      {failed && <AlertCircle size={12} className="shrink-0 text-destructive" />}
    </>
  )

  // Touch: the header is a 44px row so tapping toggle / open is easy to hit.
  const toggleButtonClass =
    'flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-xs pointer-coarse:min-h-11 outline-none transition-colors hover:bg-muted/50 active:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring'

  return (
    <div
      data-diff-block={diff.path}
      data-diff-open={bodyOpen ? 'true' : 'false'}
      className="my-1 overflow-hidden rounded-md border border-border/50 bg-background/50"
    >
      <div className="flex items-center">
        {hasLines ? (
          <button
            type="button"
            aria-expanded={bodyOpen}
            aria-label={bodyOpen ? `Collapse diff for ${name}` : `Expand diff for ${name}`}
            onClick={() => setBodyOpen((v) => !v)}
            className={toggleButtonClass}
          >
            {headerLabel}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-xs pointer-coarse:min-h-11">
            {headerLabel}
          </div>
        )}
        {onOpenFile && (
          <div className="shrink-0 pr-1.5">
            <button
              type="button"
              aria-label={`Open ${name} at line ${openLine}`}
              title={`Open ${name} at line ${openLine}`}
              onClick={() => onOpenFile(diff.path, openLine)}
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ExternalLink size={12} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      {hasLines && (
        <CollapseExpandMotion open={bodyOpen}>
          <div className="relative border-t border-border/40">
            <div
              data-diff-rows={collapsed ? 'collapsed' : 'expanded'}
              className={cn(
                'p-2 font-mono text-xs leading-relaxed',
                collapsed
                  ? hasMoreBelow && '[mask-image:linear-gradient(to_bottom,black_45%,transparent)]'
                  : 'scroller-thin max-h-48 overflow-auto overscroll-contain'
              )}
            >
              <DiffRows lines={visible} highlight={highlight} />
            </div>
            {collapsed && (
              <button
                type="button"
                aria-label={`Show full diff of ${name}`}
                onClick={() => setExpanded(true)}
                className="absolute inset-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
              />
            )}
          </div>
        </CollapseExpandMotion>
      )}
    </div>
  )
}
