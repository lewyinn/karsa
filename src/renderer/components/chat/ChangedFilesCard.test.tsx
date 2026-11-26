import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangedFilesCard, parseUnifiedDiff } from './ChangedFilesCard'
import type { ChatChangedFiles } from './use-chat-changed-files'

const mocks = vi.hoisted(() => ({
  getDiff: vi.fn(),
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  discardFiles: vi.fn(),
  refreshDiffStat: vi.fn(),
  log: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  gitApi: {
    getDiff: mocks.getDiff
  }
}))
vi.mock('@/stores/git-status-store', () => ({
  useGitStatusStore: {
    getState: () => ({
      stageFiles: mocks.stageFiles,
      unstageFiles: mocks.unstageFiles,
      discardFiles: mocks.discardFiles,
      refreshDiffStat: mocks.refreshDiffStat
    })
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.log }))
vi.mock('@/components/file-explorer/MaterialFileIcon', () => ({
  MaterialFileIcon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />
}))

const SAMPLE_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' export { a, b }'
].join('\n')

const SAMPLE_CHANGES: ChatChangedFiles = {
  files: [
    { path: '/repo/src/app.ts', added: 1, removed: 1, status: 'modified' },
    { path: '/repo/src/util.ts', added: 5, removed: 2, status: 'modified' }
  ],
  rowBase: '/repo',
  source: 'git',
  totalAdded: 6,
  totalRemoved: 3
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getDiff.mockResolvedValue(SAMPLE_DIFF)
})

describe('parseUnifiedDiff', () => {
  it('extracts hunk headers and line numbers for added, removed, and context lines', () => {
    const parsed = parseUnifiedDiff(SAMPLE_DIFF)
    expect(parsed).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'context', oldLine: 1, newLine: 1, text: 'const a = 1' },
      { kind: 'removed', oldLine: 2, text: 'const b = 2' },
      { kind: 'added', newLine: 2, text: 'const b = 3' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'export { a, b }' }
    ])
  })
})

describe('ChangedFilesCard', () => {
  it('expands file rows downward and drops inline diff open without opening a side panel', async () => {
    render(<ChangedFilesCard changes={SAMPLE_CHANGES} cwd="/repo" toolCalls={[]} />)

    const header = screen.getByRole('button', { name: /2 files changed/i })
    expect(header).toHaveTextContent('+6')
    expect(header).toHaveTextContent('-3')

    fireEvent.click(header)
    const appRow = screen.getByTestId('changed-file-row-app.ts')
    expect(appRow).toHaveTextContent('app.ts')
    expect(appRow).toHaveTextContent('src')
    expect(appRow).toHaveTextContent('+1')
    expect(appRow).toHaveTextContent('-1')

    fireEvent.click(appRow)
    await waitFor(() => expect(mocks.getDiff).toHaveBeenCalledWith('/repo', 'src/app.ts', false))
    expect(await screen.findByText('const b = 3')).toBeInTheDocument()
    expect(screen.getByText('const b = 2')).toBeInTheDocument()
  })

  it('Review button expands the list and opens inline diffs for every changed file', async () => {
    render(<ChangedFilesCard changes={SAMPLE_CHANGES} cwd="/repo" toolCalls={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    await waitFor(() => expect(mocks.getDiff).toHaveBeenCalledWith('/repo', 'src/app.ts', false))
    await waitFor(() => expect(mocks.getDiff).toHaveBeenCalledWith('/repo', 'src/util.ts', false))
    expect(screen.getByRole('button', { name: 'Hide diffs' })).toBeInTheDocument()
  })

  it('loads diffs against each file owning repoRoot in multi-repo workspaces', async () => {
    const multiRepoChanges: ChatChangedFiles = {
      files: [
        {
          path: '/work/internity/frontend/src/Login.tsx',
          added: 12,
          removed: 4,
          status: 'modified',
          repoRoot: '/work/internity/frontend',
          repoLabel: 'frontend'
        },
        {
          path: '/work/internity/backend/src/auth.ts',
          added: 8,
          removed: 2,
          status: 'modified',
          repoRoot: '/work/internity/backend',
          repoLabel: 'backend'
        }
      ],
      rowBase: '/work/internity',
      source: 'git',
      totalAdded: 20,
      totalRemoved: 6
    }

    render(<ChangedFilesCard changes={multiRepoChanges} cwd="/work/internity" toolCalls={[]} />)

    fireEvent.click(screen.getByRole('button', { name: /2 files changed/i }))
    expect(screen.getByTestId('changed-file-row-Login.tsx')).toHaveTextContent('frontend')
    expect(screen.getByTestId('changed-file-row-auth.ts')).toHaveTextContent('backend')

    fireEvent.click(screen.getByTestId('changed-file-row-Login.tsx'))
    await waitFor(() =>
      expect(mocks.getDiff).toHaveBeenCalledWith('/work/internity/frontend', 'src/Login.tsx', false)
    )

    fireEvent.click(screen.getByTestId('changed-file-row-auth.ts'))
    await waitFor(() =>
      expect(mocks.getDiff).toHaveBeenCalledWith('/work/internity/backend', 'src/auth.ts', false)
    )
  })

  it('supports per-file stage, unstage, and confirmed revert against the file repoRoot', async () => {
    mocks.stageFiles.mockResolvedValue(undefined)
    mocks.unstageFiles.mockResolvedValue(undefined)
    mocks.discardFiles.mockResolvedValue(undefined)
    mocks.refreshDiffStat.mockResolvedValue(undefined)

    const changes: ChatChangedFiles = {
      files: [
        {
          path: '/work/frontend/src/App.tsx',
          added: 4,
          removed: 1,
          status: 'modified',
          staged: false,
          hasUnstaged: true,
          repoRoot: '/work/frontend',
          repoLabel: 'frontend'
        },
        {
          path: '/work/backend/src/api.ts',
          added: 2,
          removed: 0,
          status: 'modified',
          staged: true,
          hasUnstaged: false,
          repoRoot: '/work/backend',
          repoLabel: 'backend'
        }
      ],
      rowBase: '/work',
      source: 'git',
      totalAdded: 6,
      totalRemoved: 1
    }

    render(<ChangedFilesCard changes={changes} cwd="/work" toolCalls={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /2 files changed/i }))

    // Stage unstaged file
    fireEvent.click(screen.getByRole('button', { name: 'Stage App.tsx' }))
    await waitFor(() =>
      expect(mocks.stageFiles).toHaveBeenCalledWith('/work/frontend', ['src/App.tsx'])
    )

    // Unstage fully staged file
    fireEvent.click(screen.getByRole('button', { name: 'Unstage api.ts' }))
    await waitFor(() =>
      expect(mocks.unstageFiles).toHaveBeenCalledWith('/work/backend', ['src/api.ts'])
    )

    // Revert opens confirmation dialog and discards only after confirming
    fireEvent.click(screen.getByRole('button', { name: 'Revert App.tsx' }))
    expect(mocks.discardFiles).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() =>
      expect(mocks.discardFiles).toHaveBeenCalledWith('/work/frontend', ['src/App.tsx'])
    )
  })
})
