import type { AntigravityAccountsSnapshot } from '@shared/types/antigravity-accounts.types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAntigravityAccountDraft } from '@/hooks/use-project-antigravity-account-draft'
import { AntigravityProjectAccountSettings } from './AntigravityProjectAccountSettings'

const admits = vi.hoisted(() => ({ value: true }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => admits.value
}))
vi.mock('@/lib/antigravity-account-sign-in', () => ({
  ANTIGRAVITY_SIGN_IN_METHODS: [],
  isAntigravitySignInCancelled: () => false,
  signInAntigravityAccount: vi.fn()
}))

const snapshot: AntigravityAccountsSnapshot = {
  accounts: [
    { id: 'default', name: 'Personal', builtin: true, signedIn: true },
    { id: 'ab12', name: 'Work', builtin: false, signedIn: false }
  ],
  defaultAccountId: 'default',
  projectAccounts: {},
  chatAccounts: {},
  autoSwitch: false
}

function draft(value: string | null = null): ProjectAntigravityAccountDraft {
  return {
    accounts: {
      snapshot,
      loading: false,
      error: null,
      reload: vi.fn()
    },
    value,
    dirty: false,
    setValue: vi.fn(),
    save: vi.fn(),
    reset: vi.fn()
  }
}

beforeEach(() => {
  admits.value = true
})

describe('AntigravityProjectAccountSettings', () => {
  it('lets a signed-in account be chosen and blocks a signed-out one', () => {
    const antigravity = draft()
    const onChange = vi.fn()
    render(
      <AntigravityProjectAccountSettings
        antigravity={antigravity}
        onChange={onChange}
        onManageAccounts={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('option', { name: /^Personal/ }))
    expect(antigravity.setValue).toHaveBeenCalledWith('default')
    expect(onChange).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name: /Work/ }))
    expect(antigravity.setValue).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('follows the default when that row is chosen', () => {
    const antigravity = draft('default')
    render(
      <AntigravityProjectAccountSettings
        antigravity={antigravity}
        onChange={vi.fn()}
        onManageAccounts={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('option', { name: /Follow default/ }))
    expect(antigravity.setValue).toHaveBeenCalledWith(null)
  })
})
