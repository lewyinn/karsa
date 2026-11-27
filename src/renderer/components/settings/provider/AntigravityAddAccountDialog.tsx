import type {
  AntigravityAccountUsage,
  AntigravityAccountView
} from '@shared/types/antigravity-accounts.types'
import { placeholderAntigravityName } from '@/lib/antigravity-account-name'
import { antigravityAccountsApi } from '@/lib/antigravity-accounts-api'
import {
  antigravityWindowLabel,
  planLabel,
  primaryAntigravityWindow
} from '@/lib/antigravity-usage-format'
import { AddAccountDialogShell, type AddAccountProvider } from './AddAccountFlow'
import { AntigravitySignInRun } from './AntigravitySignInStep'

interface AntigravityAddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Names already in use, so suggestions skip them. */
  existingNames: string[]
  defaultAccountName: string | null
  hasSignedInAccount: boolean
  /** Latest usage reads, to summarise the new Account when it is ready. */
  usage: Record<string, AntigravityAccountUsage>
  /** Called after the Account list changed (created, signed in, default). */
  onChanged: () => Promise<void>
  /** Read the new Account's usage after it signed in. */
  onSignedIn: (account: AntigravityAccountView) => Promise<void>
}

/**
 * "Add account" for Antigravity: the Sign in step picks a Google account or
 * Gemini Enterprise. Closing via Cancel, Escape, or X aborts any running
 * sign-in and stops the spawned sign-in agent.
 */
export function AntigravityAddAccountDialog({
  usage,
  ...props
}: AntigravityAddAccountDialogProps): React.JSX.Element {
  const provider: AddAccountProvider<AntigravityAccountView> = {
    id: 'antigravity',
    create: async (name) => {
      const created = await antigravityAccountsApi.add(name)
      return { id: created.id, name: created.name, builtin: false, signedIn: false }
    },
    placeholderName: placeholderAntigravityName,
    refreshName: async (account) => {
      const snapshot = await antigravityAccountsApi.list()
      return snapshot.accounts.find((row) => row.id === account.id)?.name ?? null
    },
    setDefault: (id) => antigravityAccountsApi.setDefault(id),
    summary: (account) => {
      const read = usage[account.id]
      const primary = primaryAntigravityWindow(read)
      return {
        plan: planLabel(read?.planType ?? null),
        usageLabel: primary ? antigravityWindowLabel(primary) : 'Usage',
        usageValue: primary ? `${Math.round(primary.percent)}% used` : 'not started'
      }
    },
    renderSignIn: ({ account, onSignedIn, onFailed, onCancel }) => (
      <AntigravitySignInRun
        account={account}
        onSignedIn={onSignedIn}
        onFailed={onFailed}
        onCancel={onCancel}
      />
    ),
    failedReason: 'The sign-in window closed or timed out.'
  }
  return <AddAccountDialogShell provider={provider} {...props} />
}
