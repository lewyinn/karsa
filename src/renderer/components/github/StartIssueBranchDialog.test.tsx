import type { GithubItemDetail } from '@shared/types/github.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { useGitStatusStore } from '@/stores/git-status-store'
import { StartIssueBranchDialog, suggestIssueBranchName } from './StartIssueBranchDialog'

const mocks = vi.hoisted(() => ({
  branchCreate: vi.fn(),
  launchChat: vi.fn(),
  seedComposerDraft: vi.fn(),
  persistenceRead: vi.fn()
}))

vi.mock('@/components/agents/launcher/launch-chat', () => ({
  launchChat: mocks.launchChat
}))
vi.mock('@/components/chat/use-composer-draft', () => ({
  seedComposerDraft: mocks.seedComposerDraft
}))
vi.mock('@/lib/api', () => ({
  persistenceApi: { read: mocks.persistenceRead }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

const SAMPLE_DETAIL: GithubItemDetail = {
  repo: { host: 'github.com', owner: 'lewyinn', name: 'backend' },
  item: {
    kind: 'issue',
    number: 42,
    title: 'Fix login timeout on slow network',
    state: 'open',
    url: 'https://github.com/lewyinn/backend/issues/42',
    author: { login: 'lewyinn', avatarUrl: null },
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: [],
    commentCount: 0,
    updatedAt: '2026-11-26T00:00:00Z',
    isDraft: false,
    headRefName: null
  },
  body: 'Users hit timeout after 5 seconds.',
  createdAt: '2026-11-26T00:00:00Z',
  comments: [],
  timeline: [],
  stateReason: null,
  pr: null,
  fetchedAt: '2026-11-26T00:00:00Z'
}

beforeEach(() => {
  vi.clearAllMocks()
  useGitStatusStore.setState({ branchCreate: mocks.branchCreate })
  mocks.branchCreate.mockResolvedValue(undefined)
  mocks.persistenceRead.mockResolvedValue({ success: false })
  mocks.launchChat.mockReturnValue({
    placeholderId: 'ph-1',
    started: Promise.resolve('sess-42')
  })
  useAcpStore.setState({
    agentConfigs: [{ id: 'claude-acp', name: 'Claude Code' } as never]
  })
})

describe('suggestIssueBranchName', () => {
  it('picks prefix from labels or title and builds a git-safe slug', () => {
    expect(suggestIssueBranchName(42, 'Fix login timeout!', [{ name: 'bug' }])).toBe(
      'fix/42-fix-login-timeout'
    )
    expect(suggestIssueBranchName(7, 'Add CSV export', [{ name: 'enhancement' }])).toBe(
      'feat/7-add-csv-export'
    )
  })
})

describe('StartIssueBranchDialog', () => {
  it('creates the branch in the issue repo and seeds the AI chat draft', async () => {
    const onOpenChange = vi.fn()
    render(
      <StartIssueBranchDialog
        open
        onOpenChange={onOpenChange}
        projectId="p1"
        itemRef={{
          cwd: '/work/internity/backend',
          repo: 'origin',
          kind: 'issue',
          number: 42
        }}
        detail={SAMPLE_DETAIL}
      />
    )

    const input = screen.getByLabelText('New branch name')
    expect(input).toHaveValue('fix/42-fix-login-timeout-on-slow-network')

    fireEvent.click(screen.getByRole('button', { name: /create branch & open chat/i }))

    await waitFor(() =>
      expect(mocks.branchCreate).toHaveBeenCalledWith(
        '/work/internity/backend',
        'fix/42-fix-login-timeout-on-slow-network'
      )
    )
    await waitFor(() =>
      expect(mocks.seedComposerDraft).toHaveBeenCalledWith(
        'p1',
        'sess-42',
        expect.stringContaining('Fix login timeout on slow network')
      )
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
