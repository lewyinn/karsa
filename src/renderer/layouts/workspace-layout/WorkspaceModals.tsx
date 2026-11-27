import type { ShellInfo } from '@shared/types/ipc.types'
import { lazy, Suspense } from 'react'
import { openNewChat, openNewQuickChat } from '@/components/chat/new-chat/open-new-chat'
import { NewProjectModal } from '@/components/NewProjectModal'
import { ProjectBusyDialog } from '@/components/ProjectBusyDialog'
import type { useCommandPaletteData } from '@/layouts/workspace-layout/use-command-palette-data'
import type { useOverlayActions } from '@/layouts/workspace-layout/use-overlay-actions'
import type { useShortcutLabels } from '@/layouts/workspace-layout/use-shortcut-labels'
import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import {
  WorkspaceCloseDialogs,
  type WorkspaceCloseDialogsProps
} from '@/layouts/workspace-layout/WorkspaceCloseDialogs'
import { WorktreeCreateModalHost } from '@/layouts/workspace-layout/WorktreeCreateModalHost'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useReportBugOpen, useReportBugStore } from '@/stores/report-bug-store'
import { useSettingsModalView } from '@/stores/settings-modal-store'
import { useThemePickerOpen } from '@/stores/theme-picker-store'
import type { Project } from '@/types/project'
import type { TerminalProfile } from '@/types/settings'

const CommandHistoryModal = lazy(() =>
  import('@/components/CommandHistoryModal').then((m) => ({
    default: m.CommandHistoryModal
  }))
)
const CommandPalette = lazy(() =>
  import('@/components/CommandPalette').then((m) => ({ default: m.CommandPalette }))
)
const ReportBugDialog = lazy(() =>
  import('@/components/bug-report/ReportBugDialog').then((m) => ({ default: m.ReportBugDialog }))
)
const ThemePicker = lazy(() =>
  import('@/components/ThemePicker').then((m) => ({ default: m.ThemePicker }))
)
const ProjectSettingsModal = lazy(() =>
  import('@/pages/ProjectSettings').then((m) => ({ default: m.ProjectSettingsModal }))
)
const AppPreferencesModal = lazy(() =>
  import('@/pages/AppPreferences').then((m) => ({ default: m.AppPreferencesModal }))
)

interface WorkspaceModalsProps extends WorkspaceCloseDialogsProps {
  isMobileWebShell: boolean
  projects: Project[]
  activeProjectId: string
  addProject: Parameters<typeof NewProjectModal>[0]['onCreateProject']
  selectProject: (id: string) => void
  switchProjectFromPalette: (id: string) => unknown
  isNewProjectModalOpen: boolean
  setIsNewProjectModalOpen: (open: boolean) => void
  isCommandPaletteOpen: boolean
  setIsCommandPaletteOpen: (open: boolean) => void
  isCommandHistoryOpen: boolean
  setIsCommandHistoryOpen: (open: boolean) => void
  ssh: SSHWorkspaceState
  overlayActions: ReturnType<typeof useOverlayActions>
  paletteData: ReturnType<typeof useCommandPaletteData>
  shortcutLabels: ReturnType<typeof useShortcutLabels>
  handleAddTerminal: (paneId: string | undefined, shell?: ShellInfo) => void
  handleOpenTerminalProfile: (profile: TerminalProfile) => void
  handleLaunchAgent: () => Promise<void>
  handleNewBrowserTab: (paneId?: string) => void
  handleOpenCanvas: () => void
}

/** Every app-level modal and confirmation, composed once for both shells. */
export function WorkspaceModals({
  isMobileWebShell,
  projects,
  activeProjectId,
  addProject,
  selectProject,
  switchProjectFromPalette,
  isNewProjectModalOpen,
  setIsNewProjectModalOpen,
  isCommandPaletteOpen,
  setIsCommandPaletteOpen,
  isCommandHistoryOpen,
  setIsCommandHistoryOpen,
  ssh,
  overlayActions,
  paletteData,
  shortcutLabels,
  handleAddTerminal,
  handleOpenTerminalProfile,
  handleLaunchAgent,
  handleNewBrowserTab,
  handleOpenCanvas,
  terminals,
  terminalClose,
  editorTabClose,
  appClose,
  bulkTabClose
}: WorkspaceModalsProps): React.JSX.Element {
  const settingsModalView = useSettingsModalView()
  const isThemePickerOpen = useThemePickerOpen()
  const isReportBugOpen = useReportBugOpen()
  const terminalProfiles = useAppSettingsStore((state) => state.settings.terminalProfiles)
  const { sshProfiles, handleSSHConnect } = ssh
  const {
    handleOpenProjectSettings,
    handleOpenAppPreferences,
    handleOpenCommandHistory,
    handleOpenShortcutMenu,
    handleOpenThemePicker
  } = overlayActions
  const { commandHistory, allCommandHistory, handleInsertCommand, handleClearCommandHistory } =
    paletteData
  const { getShortcutLabel, getProjectShortcutLabel } = shortcutLabels

  return (
    <>
      <NewProjectModal
        isOpen={isNewProjectModalOpen}
        onClose={() => setIsNewProjectModalOpen(false)}
        onCreateProject={addProject}
      />

      <ProjectBusyDialog />

      <WorktreeCreateModalHost />

      {isThemePickerOpen && (
        <Suspense fallback={null}>
          <ThemePicker />
        </Suspense>
      )}

      {isReportBugOpen && (
        <Suspense fallback={null}>
          <ReportBugDialog />
        </Suspense>
      )}

      {isCommandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            isOpen={isCommandPaletteOpen}
            onClose={() => setIsCommandPaletteOpen(false)}
            projects={projects}
            onSwitchProject={
              isMobileWebShell ? (id) => switchProjectFromPalette(id) : selectProject
            }
            onAddTerminal={() => handleAddTerminal(undefined)}
            terminalProfiles={terminalProfiles}
            onOpenTerminalProfile={handleOpenTerminalProfile}
            onNewChat={() => void openNewChat({ reason: 'command-palette' })}
            onNewQuickChat={() => void openNewQuickChat('command-palette-quick')}
            onLaunchAgent={handleLaunchAgent}
            onNewBrowserTab={handleNewBrowserTab}
            onOpenCanvas={handleOpenCanvas}
            onNewProject={isMobileWebShell ? () => setIsNewProjectModalOpen(true) : undefined}
            onOpenProjectSettings={handleOpenProjectSettings}
            onOpenAppPreferences={handleOpenAppPreferences}
            onOpenCommandHistory={activeProjectId ? handleOpenCommandHistory : undefined}
            onOpenShortcutMenu={handleOpenShortcutMenu}
            onOpenThemePicker={handleOpenThemePicker}
            onReportBug={() => useReportBugStore.getState().openReport()}
            onSSHConnect={handleSSHConnect}
            sshProfiles={sshProfiles.map((p) => ({
              id: p.id,
              name: p.name,
              host: p.host,
              username: p.username
            }))}
            getShortcutLabel={getShortcutLabel}
            getProjectShortcutLabel={getProjectShortcutLabel}
            chatsProject={
              isMobileWebShell ? undefined : projects.find((p) => p.id === activeProjectId)
            }
          />
        </Suspense>
      )}

      {isCommandHistoryOpen && (
        <Suspense fallback={null}>
          <CommandHistoryModal
            isOpen={isCommandHistoryOpen}
            onClose={() => setIsCommandHistoryOpen(false)}
            entries={commandHistory}
            allEntries={allCommandHistory}
            onSelectCommand={handleInsertCommand}
            onClearHistory={handleClearCommandHistory}
          />
        </Suspense>
      )}

      {settingsModalView === 'project' && (
        <Suspense fallback={null}>
          <ProjectSettingsModal />
        </Suspense>
      )}

      {settingsModalView === 'app' && (
        <Suspense fallback={null}>
          <AppPreferencesModal />
        </Suspense>
      )}

      <WorkspaceCloseDialogs
        terminals={terminals}
        terminalClose={terminalClose}
        editorTabClose={editorTabClose}
        appClose={appClose}
        bulkTabClose={bulkTabClose}
      />
    </>
  )
}
