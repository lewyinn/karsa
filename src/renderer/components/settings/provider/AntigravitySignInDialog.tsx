import type { AntigravityAccountView } from '@shared/types/antigravity-accounts.types'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { AntigravitySignInRun } from './AntigravitySignInStep'

/**
 * Sign in an existing Antigravity account: the "Sign in" step of the Add account
 * dialog on its own. Closing via Cancel, Escape, or X aborts any running
 * sign-in and stops the spawned sign-in agent.
 */
export function AntigravitySignInDialog({
  account,
  onClose,
  onSignedIn
}: {
  account: AntigravityAccountView | null
  onClose: () => void
  onSignedIn: (account: AntigravityAccountView) => Promise<void>
}): React.JSX.Element {
  return (
    <Dialog
      open={account !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[90dvh] gap-5 overflow-y-auto overscroll-contain sm:max-w-[400px]">
        {/* The content unmounts on close, aborting any running sign-in. */}
        {account && (
          <AntigravitySignInRun
            account={account}
            onSignedIn={() => void onSignedIn(account)}
            onCancel={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
