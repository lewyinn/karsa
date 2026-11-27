import type {
  AntigravityAccountsSnapshot,
  AntigravityAccountUsage
} from '@shared/types/antigravity-accounts.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANTIGRAVITY_USAGE_POLL_MS } from '@/hooks/use-antigravity-accounts'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'
import { AntigravityProviderSettings } from './AntigravityProviderSettings'
import { formatAntigravityChecked } from './AntigravityUsageCheck'

const {
  api,
  toast,
  admits,
  applyProjectAntigravityAccount,
  applyRemovedAntigravityAccount,
  signInAntigravityAccount
} = vi.hoisted(() => ({
  admits: { value: true },
  applyProjectAntigravityAccount: vi.fn(),
  applyRemovedAntigravityAccount: vi.fn(),
  signInAntigravityAccount: vi.fn(),
  api: {
    list: vi.fn(),
    add: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    setDefault: vi.fn(),
    setProjectAccount: vi.fn(),
    setAutoSwitch: vi.fn(),
    startLogin: vi.fn(),
    usage: vi.fn(),
    checkUsage: vi.fn()
  },
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/lib/antigravity-accounts-api', () => ({ antigravityAccountsApi: api }))
vi.mock('@/lib/antigravity-account-sign-in', () => ({
  ANTIGRAVITY_SIGN_IN_METHODS: [
    { id: 'oauth-personal', label: 'Log in with Google' },
    { id: 'oauth-business', label: 'Log in with Gemini Enterprise' }
  ],
  isAntigravitySignInMethod: (id: string) => id === 'oauth-personal' || id === 'oauth-business',
  isAntigravitySignInCancelled: (err: unknown) =>
    err instanceof Error && err.name === 'AntigravitySignInCancelledError',
  antigravityLaunchConfig: () => LAUNCH_CONFIG,
  signInAntigravityAccount
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/stores/antigravity-account-switch', () => ({
  applyProjectAntigravityAccount,
  applyRemovedAntigravityAccount
}))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => admits.value
}))

const LAUNCH_CONFIG = {
  configId: 'acp-registry:antigravity-acp',
  name: 'Antigravity',
  command: 'agy',
  args: [],
  env: {}
}

const SNAPSHOT: AntigravityAccountsSnapshot = {
  accounts: [
    { id: 'default', name: 'Personal', builtin: true, signedIn: true },
    { id: 'ab12', name: 'Work', builtin: false, signedIn: false }
  ],
  defaultAccountId: 'default',
  projectAccounts: { office: 'ab12' },
  chatAccounts: {},
  autoSwitch: true
}

const openMenu = (name: string): void => {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Actions for ${name}` }), {
    button: 0,
    ctrlKey: false
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  admits.value = true
  useProjectStore.setState({
    projects: [{ id: 'office', name: 'm-pos', color: 'blue', path: '/code/m-pos' } as Project]
  })
  api.list.mockResolvedValue(SNAPSHOT)
  api.add.mockResolvedValue({ id: 'cd34', name: 'Side', createdAt: 1 })
  api.rename.mockResolvedValue(undefined)
  api.remove.mockResolvedValue({ movedProjectIds: ['office'], movedChatIds: [] })
  api.setDefault.mockResolvedValue(undefined)
  api.setAutoSwitch.mockResolvedValue(undefined)
  api.usage.mockResolvedValue([])
  signInAntigravityAccount.mockResolvedValue(undefined)
  applyProjectAntigravityAccount.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AntigravityProviderSettings', () => {
  it('lists each Antigravity account and automatic switching', async () => {
    render(<AntigravityProviderSettings />)
    const personal = await screen.findByTestId('antigravity-account-default')
    expect(personal).toHaveTextContent('Personal')
    expect(personal).toHaveTextContent('Default')
    expect(personal).toHaveTextContent('Signed in')
    const work = screen.getByTestId('antigravity-account-ab12')
    expect(work).toHaveTextContent('Work')
    expect(work).toHaveTextContent('Signed out')
    expect(work).toHaveTextContent('m-pos')
    expect(screen.getByLabelText('Switch accounts automatically')).toBeChecked()
    expect(screen.getByLabelText('Switch accounts automatically')).toHaveAccessibleDescription(
      "When a chat reaches its account's limit, move it to another signed-in account. Off by default, because Google's terms may not allow it."
    )
  })

  it('shows one usage bar per model and the plan', async () => {
    api.usage.mockResolvedValue([
      {
        accountId: 'default',
        status: 'ok',
        planType: 'Google AI Pro',
        windows: [
          {
            kind: 'model',
            label: 'Gemini 3 Pro',
            modelId: 'gemini-3-pro',
            percent: 82,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString()
          },
          {
            kind: 'model',
            label: 'Gemini 3 Flash',
            modelId: 'gemini-3-flash',
            percent: 10,
            resetsAt: new Date(Date.now() + 86_400_000).toISOString()
          }
        ],
        checkedAt: Date.now(),
        message: null
      }
    ])
    render(<AntigravityProviderSettings />)
    const personal = await screen.findByTestId('antigravity-account-default')
    await waitFor(() => expect(personal).toHaveTextContent('82%'))
    expect(personal).toHaveTextContent('Google AI Pro')
    expect(personal).toHaveTextContent('Gemini 3 Pro')
    expect(personal).toHaveTextContent('Gemini 3 Flash')
    expect(
      within(personal).getByRole('progressbar', { name: 'Gemini 3 Pro usage' })
    ).toHaveAttribute('aria-valuenow', '82')
  })

  it('shows one status dot line per row and no Default pill on an account named Default', async () => {
    api.list.mockResolvedValue({
      ...SNAPSHOT,
      accounts: [{ id: 'default', name: 'Default', builtin: true, signedIn: undefined }],
      projectAccounts: {},
      chatAccounts: {}
    })
    render(<AntigravityProviderSettings />)
    const row = await screen.findByTestId('antigravity-account-default')
    expect(row).toHaveTextContent('Could not check sign-in')
    expect(row.textContent?.match(/Default/g)).toHaveLength(1)
    expect(screen.getByTestId('antigravity-second-account-hint')).toBeInTheDocument()
    expect(
      screen.queryByRole('switch', { name: 'Switch accounts automatically' })
    ).not.toBeInTheDocument()
  })

  it('stores the automatic-switching flag without switching chats', async () => {
    render(<AntigravityProviderSettings />)
    fireEvent.click(await screen.findByLabelText('Switch accounts automatically'))
    await waitFor(() => expect(api.setAutoSwitch).toHaveBeenCalledWith(false))
    expect(applyProjectAntigravityAccount).not.toHaveBeenCalled()
  })

  it('adds an account in the same steps as Claude: name, sign in, ready', async () => {
    signInAntigravityAccount.mockResolvedValue(undefined)
    render(<AntigravityProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Add an Antigravity account')).toBeInTheDocument()
    expect(within(dialog).getByTestId('second-account-notice')).toHaveTextContent(
      "Karsa does not recommend using many Antigravity accounts. A separate work account is fine. Using several accounts to get past usage limits can break Google's terms and get your accounts suspended. More info"
    )
    expect(within(dialog).getByLabelText('Steps')).toHaveTextContent('1Name2Sign in3Done')
    // "Work" and "Personal" are in use, so only "Team" is suggested.
    expect(within(dialog).queryByRole('button', { name: 'Work' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Team' })).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Side' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(api.add).toHaveBeenCalledWith('Side'))
    expect(await screen.findByText('Sign in to Side')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in with Google' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Log in with Gemini Enterprise' }))
    await waitFor(() =>
      expect(signInAntigravityAccount).toHaveBeenCalledWith(
        'cd34',
        'oauth-business',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    )
    expect(await screen.findByText('Side is ready')).toBeInTheDocument()
    expect(screen.getByText('No — Personal stays default')).toBeInTheDocument()
  })

  it('lets Cancel and Escape abort a running sign-in and close the dialog', async () => {
    let capturedSignal: AbortSignal | undefined
    signInAntigravityAccount.mockImplementation(
      (_id: string, _method: string, options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal
        return new Promise<void>(() => undefined)
      }
    )
    render(<AntigravityProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Side' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Log in with Google' }))
    expect(await screen.findByText('Starting Antigravity…')).toBeInTheDocument()
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
    expect(cancelBtn).toBeEnabled()
    fireEvent.click(cancelBtn)
    expect(capturedSignal?.aborted).toBe(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('shows the failed step with Try again when the sign-in does not finish', async () => {
    signInAntigravityAccount.mockRejectedValue(new Error('The sign-in timed out.'))
    render(<AntigravityProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Side' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Log in with Google' }))
    expect(await screen.findByText('Sign-in did not finish')).toBeInTheDocument()
    expect(
      screen.getByText(/The sign-in timed out\. Side stays in your list, signed out\./)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(
      await screen.findByRole('button', { name: 'Log in with Gemini Enterprise' })
    ).toBeInTheDocument()
  })

  it('renames, sets the default, and removes with a project move', async () => {
    api.list.mockResolvedValue({
      ...SNAPSHOT,
      accounts: [SNAPSHOT.accounts[0], { ...SNAPSHOT.accounts[1], signedIn: true }]
    })
    render(<AntigravityProviderSettings />)
    await screen.findByTestId('antigravity-account-ab12')
    openMenu('Work')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Office' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('ab12', 'Office'))

    openMenu('Personal')
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).not.toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Escape' })

    openMenu('Work')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make default' }))
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith('ab12'))

    openMenu('Work')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('ab12'))
    expect(applyRemovedAntigravityAccount).toHaveBeenCalledWith(
      { movedProjectIds: ['office'], movedChatIds: [] },
      []
    )
    expect(applyProjectAntigravityAccount).not.toHaveBeenCalled()
  })

  it('does not make a signed-out account the default', async () => {
    render(<AntigravityProviderSettings />)
    await screen.findByTestId('antigravity-account-ab12')
    openMenu('Work')
    const item = await screen.findByRole('menuitem', { name: /Make default/ })
    expect(item).toHaveAttribute('data-disabled')
    fireEvent.click(item)
    expect(api.setDefault).not.toHaveBeenCalled()
  })

  it('checks usage only when its button is clicked, then shows the meters and the time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.usage.mockResolvedValue([
      {
        accountId: 'default',
        status: 'not_checked',
        planType: 'Google AI Pro',
        windows: [],
        checkedAt: 0,
        message: null
      }
    ])
    let answer: (read: AntigravityAccountUsage) => void = () => undefined
    api.checkUsage.mockReturnValue(
      new Promise<AntigravityAccountUsage>((resolve) => {
        answer = resolve
      })
    )
    render(<AntigravityProviderSettings />)
    const personal = await screen.findByTestId('antigravity-account-default')
    await waitFor(() => expect(personal).toHaveTextContent('Google AI Pro'))
    await vi.advanceTimersByTimeAsync(ANTIGRAVITY_USAGE_POLL_MS * 2)
    expect(api.checkUsage).not.toHaveBeenCalled()
    expect(
      within(screen.getByTestId('antigravity-account-ab12')).queryByRole('button', {
        name: /Check usage/
      })
    ).not.toBeInTheDocument()

    fireEvent.click(within(personal).getByRole('button', { name: 'Check usage of Personal' }))

    expect(api.checkUsage).toHaveBeenCalledWith('default', LAUNCH_CONFIG)
    expect(await within(personal).findByText('Reading usage…')).toBeInTheDocument()
    expect(within(personal).getByRole('button', { name: 'Check usage of Personal' })).toBeDisabled()
    const checkedAt = new Date(2026, 10, 24, 14, 5).getTime()
    vi.setSystemTime(checkedAt + 60_000)
    answer({
      accountId: 'default',
      status: 'ok',
      planType: 'Google AI Pro',
      windows: [
        {
          kind: 'model',
          label: 'Gemini Models · Weekly Limit Remaining',
          modelId: 'Gemini Models · Weekly Limit Remaining',
          percent: 9,
          resetsAt: null
        }
      ],
      checkedAt,
      message: 'Overage: Disabled'
    })
    await waitFor(() => expect(personal).toHaveTextContent('Gemini Models · Weekly Limit'))
    expect(personal).toHaveTextContent('9% used')
    expect(personal).toHaveTextContent('Google AI Pro')
    expect(personal).toHaveTextContent('Overage: Disabled')
    expect(personal).toHaveTextContent(formatAntigravityChecked(checkedAt))
    expect(api.checkUsage).toHaveBeenCalledTimes(1)
  })

  it('shows the agent line when a check reads no meter', async () => {
    api.checkUsage.mockResolvedValue({
      accountId: 'default',
      status: 'unavailable',
      planType: null,
      windows: [],
      checkedAt: Date.now(),
      message: 'Not applicable for current authentication method.'
    })
    render(<AntigravityProviderSettings />)
    const personal = await screen.findByTestId('antigravity-account-default')
    fireEvent.click(within(personal).getByRole('button', { name: 'Check usage of Personal' }))
    expect(
      await within(personal).findByText('Not applicable for current authentication method.')
    ).toBeInTheDocument()
    expect(within(personal).queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('keeps a signed-in account ready with its button whatever its last check said', async () => {
    api.usage.mockResolvedValue([
      {
        accountId: 'default',
        status: 'signed_out',
        planType: null,
        windows: [],
        checkedAt: Date.now(),
        message: 'This account is not signed in. Sign in to it, then check again.'
      }
    ])
    render(<AntigravityProviderSettings />)
    const personal = await screen.findByTestId('antigravity-account-default')
    await waitFor(() =>
      expect(personal).toHaveTextContent(
        'This account is not signed in. Sign in to it, then check again.'
      )
    )
    expect(personal).toHaveTextContent('Signed in')
    expect(personal).not.toHaveTextContent('Signed out')
    expect(within(personal).getByRole('button', { name: 'Check usage of Personal' })).toBeEnabled()
  })

  it('hides writes on a view-only connection', async () => {
    admits.value = false
    render(<AntigravityProviderSettings />)
    await screen.findByTestId('antigravity-account-default')
    expect(screen.queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Check usage/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Switch accounts automatically')).toBeDisabled()
    expect(
      screen.getByText(/Sign in from the Karsa desktop app to manage accounts/)
    ).toBeInTheDocument()
  })
})
