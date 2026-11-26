import type { ShellInfo } from '@shared/types/ipc.types'
import { useEffect } from 'react'
import { ConnectionStatusIndicator } from '@/components/ConnectionStatusIndicator'
import {
  Folder2,
  GitBranch,
  Github,
  Globe,
  KeyRound,
  Layers,
  type TermulIcon
} from '@/components/icons'
import { toolStripButtonId } from '@/components/shell/column-tab-focus'
import { logShellEvent } from '@/components/shell/shell-log'
import { useTopRowPlatform } from '@/components/shell/top-row-context'
import { useColumnWorkingCopy } from '@/components/shell/use-column-working-copy'
import { useShortcutLabel } from '@/components/shell/use-shortcut-label'
import { CountBadge } from '@/components/ui/count-badge'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { isTauriContext } from '@/lib/tauri-runtime'
import { normalizePath } from '@/lib/working-copy'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useProjectGitRepos } from '@/stores/git-repos-store'
import { selectChangedFileCount, useGitStatusStore } from '@/stores/git-status-store'
import { useQuickChatOpen } from '@/stores/quick-chat-store'
import { useRunStackStore } from '@/stores/run-stack-store'
import {
  type ShellLastColumnTab,
  useLastColumnTab,
  useShellLayoutStore
} from '@/stores/shell-layout-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { Project } from '@/types/project'
import { TerminalStripButton } from './TerminalStripButton'
import { ToolStrip } from './ToolStrip'

const VIEWS: ReadonlyArray<{ id: ShellLastColumnTab; label: string; Icon: TermulIcon }> = [
  { id: 'explorer', label: 'Explorer', Icon: Folder2 },
  { id: 'changes', label: 'Changes', Icon: GitBranch },
  { id: 'github', label: 'GitHub', Icon: Github },
  { id: 'stack', label: 'Run Stack', Icon: Layers },
  { id: 'env', label: 'Env', Icon: KeyRound }
]

interface ShellToolStripProps {
  activeProject: Project | undefined
  /** The SSH workspace is open: Explorer toggles the remote file browser, the git views are off. */
  sshOpen: boolean
  /** Opens a new terminal tab in the active pane: the default shell, or `shell`. */
  onNewTerminal: (shell?: ShellInfo) => void
  /** Opens a new browser tab in the active pane. */
  onNewBrowserTab: () => void
}

/**
 * The shell's right edge strip (Paper "Tool strip"). Top: Explorer, Changes
 * (with the changed-file count) and GitHub, each showing the right panel on
 * that view, or hiding it when that view is already open; the open view is
 * raised. Bottom: a new Terminal tab (right-click: pick the shell) and a new
 * Browser tab on every click, and Remote access (desktop only; the web
 * client shows its connection lamp there instead).
 */
export function ShellToolStrip({
  activeProject,
  sshOpen,
  onNewTerminal,
  onNewBrowserTab
}: ShellToolStripProps): React.JSX.Element {
  const desktop = isTauriContext()
  const quickChatOpen = useQuickChatOpen()
  const platform = useTopRowPlatform()
  const dragRegion = platform.dragRegions ? true : undefined
  const projectId = activeProject?.id ?? ''
  const panelVisible = useFileExplorerVisible()
  const updatePanelVisibility = useUpdatePanelVisibility()
  const selected = useLastColumnTab(projectId) ?? 'explorer'
  const { cwd } = useColumnWorkingCopy(activeProject)
  const { repos } = useProjectGitRepos(projectId, sshOpen ? '' : cwd)
  const multiRepoChangedCount = useGitStatusStore((state) => {
    if (repos.length === 0) return 0
    let total = 0
    for (const repo of repos) {
      const entries = state.statuses[normalizePath(repo.path)]
      if (entries) total += new Set(entries.map((entry) => entry.path)).size
    }
    return total
  })
  const singleRepoChangedCount = useGitStatusStore(selectChangedFileCount(cwd))
  const changedCount = repos.length > 0 ? multiRepoChangedCount : singleRepoChangedCount
  const terminalByServiceKey = useRunStackStore((state) => state.terminalByServiceKey)
  const runningStackCount = useTerminalStore((state) => {
    if (!projectId) return 0
    const prefix = `${projectId}::`
    let count = 0
    for (const [key, terminalId] of Object.entries(terminalByServiceKey)) {
      if (!key.startsWith(prefix)) continue
      const term = state.terminals.find((t) => t.id === terminalId)
      if (term?.ptyId && (term.lastExitCode === null || term.lastExitCode === undefined)) count += 1
    }
    return count
  })
  const terminalShortcut = useShortcutLabel('worktreeOpenTerminal')
  const browserShortcut = useShortcutLabel('newBrowserTab')

  // Track the working copy (or every nested sub-repo) so the Changes badge stays live.
  const trackedPath = activeProject?.isGitRepo === false || sshOpen ? '' : cwd
  useEffect(() => {
    if (sshOpen) return
    const store = useGitStatusStore.getState()
    if (repos.length > 0) {
      for (const repo of repos) {
        void store.refreshWorkingCopy(repo.path)
      }
      return
    }
    if (trackedPath) void store.refreshWorkingCopy(trackedPath)
  }, [sshOpen, repos, trackedPath])

  const hasProject = Boolean(activeProject?.path)
  // In SSH mode only Explorer works: it shows the remote file browser.
  const viewEnabled = (view: ShellLastColumnTab): boolean =>
    sshOpen ? view === 'explorer' : hasProject
  const viewOpen = (view: ShellLastColumnTab): boolean =>
    panelVisible && (sshOpen ? view === 'explorer' : selected === view)

  const handleView = (view: ShellLastColumnTab): void => {
    const hide = viewOpen(view)
    if (!hide && !sshOpen) useShellLayoutStore.getState().setLastColumnTab(projectId, view)
    if (hide || !panelVisible) {
      void updatePanelVisibility('fileExplorerVisible', !hide).catch((error: unknown) => {
        logShellEvent(
          `right panel toggle failed: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      })
    }
    logShellEvent(`right panel ${hide ? 'hidden' : `shows ${view}`} via strip`)
  }

  const tabsEnabled = hasProject && !sshOpen

  return (
    <ToolStrip
      aria-label="Tools"
      data-testid="tool-strip"
      data-tauri-drag-region={dragRegion}
      // Windows/Linux: the strip starts below the window controls (44px row).
      className={platform.windowControls ? 'pt-[50px]' : undefined}
    >
      {/* A quick chat has no project: no project views. New terminal and
          New browser tab stay; they close the quick chat first. */}
      {!quickChatOpen && (
        <ToolStrip.Group>
          {VIEWS.map(({ id, label, Icon }) => {
            const open = viewOpen(id)
            return (
              <ToolStrip.Button
                key={id}
                id={toolStripButtonId(id)}
                label={label}
                active={open}
                aria-pressed={open}
                disabled={!viewEnabled(id)}
                onClick={() => handleView(id)}
                icon={<Icon size={14} aria-hidden />}
                badge={
                  id === 'changes' && changedCount > 0 && !sshOpen ? (
                    <CountBadge
                      count={changedCount}
                      max={99}
                      data-testid="tool-strip-changes-badge"
                      className="absolute -top-[3px] -right-1 h-4 min-w-4 text-4xs"
                    />
                  ) : id === 'stack' && runningStackCount > 0 && !sshOpen ? (
                    <CountBadge
                      count={runningStackCount}
                      max={99}
                      data-testid="tool-strip-stack-badge"
                      className="absolute -top-[3px] -right-1 h-4 min-w-4 text-4xs"
                    />
                  ) : undefined
                }
              />
            )
          })}
        </ToolStrip.Group>
      )}
      <ToolStrip.Spacer data-tauri-drag-region={dragRegion} />
      <ToolStrip.Group className="pb-2">
        <TerminalStripButton
          projectShell={activeProject?.defaultShell}
          shortcut={terminalShortcut}
          disabled={!tabsEnabled}
          onNewTerminal={onNewTerminal}
        />
        {/* Browser tabs are native webviews: desktop only. */}
        {desktop && (
          <ToolStrip.Button
            label="New browser tab"
            shortcut={browserShortcut}
            disabled={!tabsEnabled}
            onClick={() => {
              logShellEvent('strip opens a browser tab')
              onNewBrowserTab()
            }}
            icon={<Globe size={14} aria-hidden />}
          />
        )}
        {!desktop && (
          <div className="flex size-8 items-center justify-center">
            <ConnectionStatusIndicator />
          </div>
        )}
      </ToolStrip.Group>
    </ToolStrip>
  )
}
