import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  branchMatchesIssue,
  commitMatchesIssue,
  GithubIssueDevelopment
} from './GithubIssueDevelopment'

const mocks = vi.hoisted(() => ({
  branchList: vi.fn(),
  getCommitContext: vi.fn(),
  getLog: vi.fn(),
  listItems: vi.fn(),
  addGithubItemTab: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  gitApi: {
    branchList: mocks.branchList,
    getCommitContext: mocks.getCommitContext,
    getLog: mocks.getLog
  }
}))
vi.mock('@/lib/github-api', () => ({
  githubApi: {
    listItems: mocks.listItems
  }
}))
vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => ({
      addGithubItemTab: mocks.addGithubItemTab
    })
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GithubIssueDevelopment matchers', () => {
  it('matches exact issue numbers in branches and commits without partial-digit collisions', () => {
    expect(branchMatchesIssue('fix/42-login-timeout', 42)).toBe(true)
    expect(branchMatchesIssue('fix/42-login-timeout', 4)).toBe(false)
    expect(
      commitMatchesIssue({ subject: 'fix(auth): resolve timeout (#42)', refs: [] }, 42, new Set())
    ).toBe(true)
    expect(
      commitMatchesIssue({ subject: 'fix(auth): resolve timeout (#420)', refs: [] }, 42, new Set())
    ).toBe(false)
  })
})

describe('GithubIssueDevelopment', () => {
  it('detects branches, commits, and PRs for an issue and posts a progress comment', async () => {
    mocks.branchList.mockResolvedValue(['main', 'fix/42-login-timeout'])
    mocks.getCommitContext.mockResolvedValue({ branch: 'fix/42-login-timeout' })
    mocks.getLog.mockResolvedValue([
      {
        hash: '1111111aaaa',
        shortHash: '1111111',
        parents: [],
        refs: ['HEAD -> fix/42-login-timeout'],
        author: 'lewyinn',
        date: '2026-11-26T10:00:00Z',
        subject: 'fix(auth): handle timeout (#42)'
      }
    ])
    mocks.listItems.mockResolvedValue({
      success: true,
      data: {
        items: [
          {
            kind: 'pr',
            number: 99,
            title: 'Fix login timeout (#42)',
            state: 'open',
            url: 'https://github.com/lewyinn/karsa/pull/99',
            author: 'lewyinn',
            labels: [],
            assignees: [],
            commentCount: 0,
            updatedAt: '2026-11-26T10:00:00Z',
            checks: null
          }
        ]
      }
    })
    const onPost = vi.fn().mockResolvedValue(undefined)

    render(
      <GithubIssueDevelopment
        cwd="/work/backend"
        repo="origin"
        issueNumber={42}
        onPostProgressComment={onPost}
      />
    )

    await waitFor(() => expect(screen.getByTestId('issue-dev-status')).toHaveTextContent('PR open'))
    expect(screen.getByText('fix/42-login-timeout')).toBeInTheDocument()
    expect(screen.getByTestId('issue-commit-1111111')).toHaveTextContent('handle timeout')

    fireEvent.click(screen.getByRole('button', { name: /post progress/i }))
    await waitFor(() =>
      expect(onPost).toHaveBeenCalledWith(expect.stringContaining('Development progress for #42'))
    )
  })
})
