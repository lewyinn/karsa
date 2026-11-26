import { lazy, Suspense } from 'react'
import { ShellSkeleton } from '@/layouts/workspace-layout/ShellSkeleton'
import { useProjectGitRepos } from '@/stores/git-repos-store'
import { useLastColumnTab } from '@/stores/shell-layout-store'
import type { Project } from '@/types/project'
import { ChangesPanel } from './ChangesPanel'
import { SidePanelHeader } from './SidePanelHeader'
import { useColumnWorkingCopy } from './use-column-working-copy'

const FileExplorer = lazy(() =>
  import('@/components/file-explorer/FileExplorer').then((m) => ({ default: m.FileExplorer }))
)

const GithubPanel = lazy(() =>
  import('@/components/github/GithubPanel').then((m) => ({ default: m.GithubPanel }))
)

const RunStackPanel = lazy(() =>
  import('@/components/stack/RunStackPanel').then((m) => ({ default: m.RunStackPanel }))
)

const EnvManagerPanel = lazy(() =>
  import('@/components/env/EnvManagerPanel').then((m) => ({ default: m.EnvManagerPanel }))
)

const UsageDashboardPanel = lazy(() =>
  import('@/components/usage/UsageDashboardPanel').then((m) => ({
    default: m.UsageDashboardPanel
  }))
)

interface SidePanelColumnProps {
  activeProject: Project
}

/**
 * Body of the right panel for a project: the view the tool strip picked
 * (Explorer, Changes or GitHub, remembered per project, Explorer by default)
 * under its Paper panel header. The Explorer and Changes views draw that
 * header themselves (`ExplorerHeader`, `ChangesPanel`), because their actions
 * need the view's state. Mounted through `ExplorerColumn`'s `sidePanel` slot,
 * never in SSH mode.
 */
export function SidePanelColumn({ activeProject }: SidePanelColumnProps): React.JSX.Element {
  const projectId = activeProject.id
  const { cwd } = useColumnWorkingCopy(activeProject)
  const selected = useLastColumnTab(projectId) ?? 'explorer'
  const { repos, activeRepoPath, githubAllRepos, setSelectedRepo, setGithubAllRepos } =
    useProjectGitRepos(projectId, cwd)

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-view={selected}>
      {selected === 'explorer' && (
        <Suspense fallback={<ShellSkeleton />}>
          <FileExplorer />
        </Suspense>
      )}
      {selected === 'changes' && (
        <ChangesPanel cwd={activeRepoPath} repos={repos} onSelectRepo={setSelectedRepo} isVisible />
      )}
      {selected === 'github' && (
        <>
          <SidePanelHeader title="GitHub" />
          <Suspense fallback={<ShellSkeleton />}>
            <GithubPanel
              projectId={projectId}
              cwd={activeRepoPath}
              repos={repos}
              allRepos={githubAllRepos}
              onSelectRepo={setSelectedRepo}
              onSelectAllRepos={() => setGithubAllRepos(true)}
            />
          </Suspense>
        </>
      )}
      {selected === 'stack' && (
        <Suspense fallback={<ShellSkeleton />}>
          <RunStackPanel projectId={projectId} projectRoot={cwd} repos={repos} />
        </Suspense>
      )}
      {selected === 'env' && (
        <Suspense fallback={<ShellSkeleton />}>
          <EnvManagerPanel projectRoot={cwd} repos={repos} />
        </Suspense>
      )}
      {selected === 'usage' && (
        <Suspense fallback={<ShellSkeleton />}>
          <UsageDashboardPanel />
        </Suspense>
      )}
    </div>
  )
}
