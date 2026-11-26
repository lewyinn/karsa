import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateIssueDialog } from './CreateIssueDialog'

const mocks = vi.hoisted(() => ({
  getRepoMeta: vi.fn(),
  createIssue: vi.fn(),
  log: vi.fn()
}))

vi.mock('@/lib/github-api', () => ({
  githubApi: {
    getRepoMeta: mocks.getRepoMeta,
    createIssue: mocks.createIssue
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.log }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getRepoMeta.mockResolvedValue({
    success: true,
    data: {
      repo: { host: 'github.com', owner: 'ridho', name: 'internity-fe' },
      labels: [{ name: 'bug', color: 'd73a4a', description: null }],
      assignableUsers: ['ridho'],
      viewer: 'ridho',
      fetchedAt: '2026-11-26T00:00:00Z'
    }
  })
  mocks.createIssue.mockResolvedValue({
    success: true,
    data: {
      number: 42,
      url: 'https://github.com/ridho/internity-fe/issues/42',
      title: 'Fix login button'
    }
  })
})

describe('CreateIssueDialog', () => {
  it('submits title, body, labels, and assignees for the selected repository', async () => {
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <CreateIssueDialog
        open
        onOpenChange={onOpenChange}
        defaultCwd="/work/internity/frontend"
        repos={[
          {
            name: 'backend',
            relativePath: 'backend',
            path: '/work/internity/backend',
            isRoot: false
          },
          {
            name: 'frontend',
            relativePath: 'frontend',
            path: '/work/internity/frontend',
            isRoot: false
          }
        ]}
        onCreated={onCreated}
      />
    )

    expect(screen.getByRole('combobox', { name: 'Target repository' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'bug' })).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fix login button' } })
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Clicking login twice hangs.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'bug' }))
    fireEvent.click(screen.getByRole('button', { name: /Assign to me/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))

    await waitFor(() =>
      expect(mocks.createIssue).toHaveBeenCalledWith({
        cwd: '/work/internity/frontend',
        repo: 'origin',
        title: 'Fix login button',
        body: 'Clicking login twice hangs.',
        labels: ['bug'],
        assignees: ['ridho']
      })
    )
    expect(onCreated).toHaveBeenCalledWith({
      cwd: '/work/internity/frontend',
      repo: 'origin',
      number: 42,
      title: 'Fix login button',
      url: 'https://github.com/ridho/internity-fe/issues/42'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
