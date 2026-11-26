import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { CreatePrDialog } from './CreatePrDialog'

const mocks = vi.hoisted(() => ({
  getCommitContext: vi.fn(),
  getLog: vi.fn(),
  resolveBaseBranch: vi.fn(),
  createPr: vi.fn(),
  generateCommitMessage: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  gitApi: {
    getCommitContext: mocks.getCommitContext,
    getLog: mocks.getLog
  }
}))
vi.mock('@/lib/worktree-api', () => ({
  worktreeApi: {
    resolveBaseBranch: mocks.resolveBaseBranch
  }
}))
vi.mock('@/lib/github-api', () => ({
  githubApi: {
    createPr: mocks.createPr
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommitContext.mockResolvedValue({
    branch: 'feat/login-fix',
    hasUpstream: true,
    ahead: 2,
    behind: 0,
    hasHead: true,
    stagedCount: 0
  })
  mocks.resolveBaseBranch.mockResolvedValue({
    success: true,
    data: { defaultBase: 'main' }
  })
  mocks.getLog.mockResolvedValue([
    { hash: 'abcdef123456', shortHash: 'abcdef1', subject: 'fix: handle timeout' }
  ])
  mocks.createPr.mockResolvedValue({
    success: true,
    data: {
      number: 15,
      url: 'https://github.com/lewyinn/karsa/pull/15',
      title: 'fix: login timeout'
    }
  })
  useAcpStore.setState({
    selectedAgentConfigId: 'claude-acp',
    agentConfigs: [{ id: 'claude-acp', name: 'Claude Code' } as never],
    generateCommitMessage: mocks.generateCommitMessage
  })
  mocks.generateCommitMessage.mockResolvedValue({
    summary: 'fix: login timeout',
    description: '## Summary\n- Handles login timeout cleanly.'
  })
})

describe('CreatePrDialog', () => {
  it('auto-fills head/base branches, drafts with AI, and creates the PR', async () => {
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <CreatePrDialog
        open
        onOpenChange={onOpenChange}
        defaultCwd="/work/backend"
        repos={[]}
        onCreated={onCreated}
      />
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Head branch (from)')).toHaveValue('feat/login-fix')
    )
    expect(screen.getByLabelText('Base branch (into)')).toHaveValue('main')

    fireEvent.click(screen.getByRole('button', { name: /generate with ai/i }))
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('fix: login timeout'))
    expect(screen.getByLabelText('Description (Markdown)')).toHaveValue(
      '## Summary\n- Handles login timeout cleanly.'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create PR' }))

    await waitFor(() =>
      expect(mocks.createPr).toHaveBeenCalledWith({
        cwd: '/work/backend',
        repo: 'origin',
        title: 'fix: login timeout',
        body: '## Summary\n- Handles login timeout cleanly.',
        head: 'feat/login-fix',
        base: 'main',
        draft: false
      })
    )
    expect(onCreated).toHaveBeenCalledWith({
      cwd: '/work/backend',
      repo: 'origin',
      number: 15,
      title: 'fix: login timeout',
      url: 'https://github.com/lewyinn/karsa/pull/15'
    })
  })
})
