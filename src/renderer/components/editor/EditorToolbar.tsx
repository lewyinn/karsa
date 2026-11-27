import { useCallback, useMemo, useState } from 'react'
import { ChevronRight, Code2, Columns2, Eye, PanelRight, Save, Sparkles } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS, SEGMENTED_TRACK_CLASS, segmentClass } from '@/components/ui/panel-styles'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { type EditorViewMode, textPreviewForPath, viewModesForPath } from '@/lib/editor-file-kind'
import { requestSaveEditorFile } from '@/lib/editor-save'
import { EDITOR_SEND_SELECTION_EVENT } from '@/lib/send-selection-to-chat'
import { cn } from '@/lib/utils'
import { useAppSettingsStore, useEditorAutoSave } from '@/stores/app-settings-store'
import { useEditorStore } from '@/stores/editor-store'
import { useTocIsVisible, useTocSettingsStore } from '@/stores/toc-settings-store'
import { formatDocumentStats, getDocumentStats } from './outline/document-stats'

interface EditorToolbarProps {
  viewMode: EditorViewMode
  onViewModeChange: (mode: EditorViewMode) => void
  filePath: string
}

/** 44px touch target on the mobile web shell: an invisible hit-slop overlay. */
const TOUCH_TARGET_CLASS = "relative min-h-11 after:absolute after:-inset-1.5 after:content-['']"

const VIEW_MODE_SEGMENTS: Readonly<
  Record<EditorViewMode, { label: string; title: string; Icon: typeof Eye }>
> = {
  preview: { label: 'Preview', title: 'Switch to preview mode', Icon: Eye },
  split: { label: 'Split', title: 'Show source and preview side by side', Icon: Columns2 },
  code: { label: 'Source', title: 'Switch to source mode', Icon: Code2 }
}

function getParentFolderName(filePath: string): string | null {
  const parts = filePath.split(/[\\/]/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : null
}

export function EditorToolbar({
  viewMode,
  onViewModeChange,
  filePath
}: EditorToolbarProps): React.JSX.Element {
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  const folderName = getParentFolderName(filePath)
  const isTocVisible = useTocIsVisible()
  const toggleTocVisibility = useTocSettingsStore((state) => state.toggleVisibility)
  // Story 9: on the mobile web shell the desktop controls are far under the
  // 44px touch floor. Swap them to the `touch` button size (h-11 + hit-slop
  // overlay); desktop keeps the compact h-6 track.
  const isMobileWebShell = useMobileWebShell()
  // Split does not fit a phone, so the mobile shell shows the split view as its preview.
  const modes = viewModesForPath(filePath).filter((mode) => !isMobileWebShell || mode !== 'split')
  const shownMode = isMobileWebShell && viewMode === 'split' ? 'preview' : viewMode
  // Story 4: the mobile editor has no other save path (no Ctrl key, hidden
  // desktop tab strip), so the toolbar exposes an explicit Save affordance.
  // Disabled unless the buffer is dirty; while a save is in flight it stays
  // disabled (requestSaveEditorFile runs the same store saveFile as Ctrl+S,
  // including flush → write → dirty-clear → boundary log).
  const fileState = useEditorStore((state) => state.openFiles.get(filePath))
  const isDirty = Boolean(fileState?.isDirty)
  const isSaving = fileState?.operationStatus === 'saving'
  const [saveTapped, setSaveTapped] = useState(false)
  const autoSave = useEditorAutoSave()
  const updateSetting = useAppSettingsStore((state) => state.updateSetting)

  const handleToggleAutoSave = useCallback(() => {
    void updateSetting('editorAutoSave', !autoSave)
  }, [autoSave, updateSetting])

  const handleAskAi = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent<{ filePath: string }>(EDITOR_SEND_SELECTION_EVENT, {
        detail: { filePath }
      })
    )
  }, [filePath])

  const isMarkdown = textPreviewForPath(filePath) === 'markdown'
  const content = isMarkdown && fileState?.kind === 'text' ? fileState.content : undefined
  const statsLabel = useMemo(
    () => (content === undefined ? null : formatDocumentStats(getDocumentStats(content))),
    [content]
  )

  const handleSave = useCallback(() => {
    const file = useEditorStore.getState().openFiles.get(filePath)
    if (!file?.isDirty) return
    setSaveTapped(true)
    void requestSaveEditorFile(filePath).finally(() => setSaveTapped(false))
  }, [filePath])

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background',
        isMobileWebShell ? 'min-h-10 px-2' : 'h-10 pl-4 pr-1.5'
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        {folderName && (
          <>
            <span className="truncate text-muted-foreground/70" title={filePath}>
              {folderName}
            </span>
            <ChevronRight
              size={12}
              aria-hidden="true"
              className="shrink-0 text-muted-foreground/70"
            />
          </>
        )}
        <span className="truncate font-medium text-muted-foreground" title={filePath}>
          {fileName}
        </span>
        {statsLabel && !isMobileWebShell && (
          <>
            <span
              aria-hidden="true"
              className="size-[3px] shrink-0 rounded-full bg-muted-foreground/40"
            />
            <span className="shrink-0 whitespace-nowrap text-muted-foreground/70 tabular-nums">
              {statsLabel}
            </span>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {!isMobileWebShell && (
          <>
            <button
              type="button"
              onClick={handleAskAi}
              title="Send selection to AI Chat (Ctrl+L)"
              aria-label="Ask AI about selection"
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 text-3xs font-medium text-secondary-foreground transition-colors hover:bg-muted/70 hover:text-foreground',
                FOCUS_RING_CLASS
              )}
            >
              <Sparkles size={11} aria-hidden="true" />
              <span>Ask AI</span>
              <span className="font-mono text-4xs text-muted-foreground">Ctrl+L</span>
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={autoSave}
              onClick={handleToggleAutoSave}
              title={
                autoSave
                  ? 'Auto-save is ON (click to turn off)'
                  : 'Auto-save is OFF (click to turn on)'
              }
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-3xs font-medium transition-colors',
                FOCUS_RING_CLASS,
                autoSave
                  ? 'bg-success/10 text-success hover:bg-success/15'
                  : 'bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-1.5 rounded-full',
                  autoSave ? 'bg-success' : 'bg-muted-foreground/50'
                )}
              />
              <span>Auto-save</span>
            </button>
          </>
        )}

        <div
          role="radiogroup"
          aria-label="View mode"
          className={cn(SEGMENTED_TRACK_CLASS, !isMobileWebShell && 'h-7')}
        >
          {modes.map((mode) => {
            const { label, title, Icon } = VIEW_MODE_SEGMENTS[mode]
            const isActive = shownMode === mode
            return (
              // biome-ignore lint/a11y/useSemanticElements: segmented track, not a native radio input
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={isActive}
                aria-label={label}
                title={title}
                onClick={() => {
                  if (!isActive) onViewModeChange(mode)
                }}
                className={cn(
                  segmentClass(isActive),
                  'gap-1',
                  isMobileWebShell ? TOUCH_TARGET_CLASS : 'h-6'
                )}
              >
                <Icon size={12} aria-hidden="true" />
                <span>{label}</span>
              </button>
            )
          })}
        </div>

        {isMarkdown && !isMobileWebShell && (
          <span aria-hidden="true" className="h-4 w-px bg-border" />
        )}

        {isMarkdown && (
          <button
            type="button"
            onClick={toggleTocVisibility}
            title={isTocVisible ? 'Hide outline' : 'Show outline'}
            aria-label="Outline"
            aria-pressed={isTocVisible}
            className={cn(
              'flex items-center justify-center rounded-md transition-colors duration-150 ease-out',
              FOCUS_RING_CLASS,
              isMobileWebShell ? cn(TOUCH_TARGET_CLASS, 'min-w-11') : 'size-7',
              isTocVisible
                ? 'bg-foreground/[0.06] text-foreground'
                : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground'
            )}
          >
            <PanelRight size={14} aria-hidden="true" />
          </button>
        )}

        {isMobileWebShell && (
          <Button
            variant="ghost"
            size="touch"
            className={cn(
              'gap-1 min-h-11 px-3 text-xs [&_svg]:size-3',
              isDirty ? 'text-foreground' : 'text-muted-foreground'
            )}
            onClick={handleSave}
            disabled={!isDirty || isSaving || saveTapped}
            title={isDirty ? 'Save file' : 'No unsaved changes'}
            aria-label={`Save ${fileName}`}
          >
            <Save size={12} />
            <span>Save</span>
          </Button>
        )}
      </div>
    </div>
  )
}
