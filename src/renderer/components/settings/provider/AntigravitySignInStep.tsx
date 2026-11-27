import {
  ANTIGRAVITY_GOOGLE_METHOD,
  type AntigravityAccountView
} from '@shared/types/antigravity-accounts.types'
import { useEffect, useRef, useState } from 'react'
import { Globe } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import {
  ANTIGRAVITY_SIGN_IN_METHODS,
  type AntigravitySignInPhase,
  isAntigravitySignInCancelled,
  signInAntigravityAccount
} from '@/lib/antigravity-account-sign-in'
import { AccountSignInWaiting, AccountStepHeader } from './account-dialog-parts'
import { accountErrorText } from './account-error'

/**
 * The Antigravity "Sign in" step: pick a Google account or Gemini Enterprise,
 * then wait while Antigravity starts and the browser sign-in window opens.
 * Cancel is always enabled so a slow boot or abandoned browser flow never traps
 * the user.
 */
export function AntigravitySignInStep({
  accountName,
  method,
  phase = 'waiting_browser',
  error,
  onPick,
  onCancel
}: {
  accountName: string
  /** The method that is running, or null while the user picks one. */
  method: string | null
  phase?: AntigravitySignInPhase
  error: string | null
  onPick: (methodId: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const description =
    method === null
      ? 'Antigravity accounts use a Google login. Sign in with a Google account, or with Gemini Enterprise for a work account.'
      : phase === 'starting'
        ? 'Starting Antigravity… This can take up to 20–30 seconds before Google sign-in opens.'
        : method === ANTIGRAVITY_GOOGLE_METHOD
          ? 'Complete sign-in with your Google account in your browser, then come back here.'
          : 'Complete sign-in with your Gemini Enterprise account in your browser, then come back here.'
  const waitingLabel = phase === 'starting' ? 'Starting Antigravity…' : 'Waiting for the sign-in…'
  return (
    <>
      <AccountStepHeader
        tone="muted"
        icon={<Globe size={15} />}
        title={`Sign in to ${accountName}`}
      >
        {description}
      </AccountStepHeader>
      {method === null ? (
        <div className="grid gap-2">
          {ANTIGRAVITY_SIGN_IN_METHODS.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={option.id === ANTIGRAVITY_GOOGLE_METHOD ? 'default' : 'secondary'}
              onClick={() => onPick(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : (
        <AccountSignInWaiting label={waitingLabel} />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * Runs an Antigravity sign-in: the method pick, then the wait. Cancelling or
 * closing the dialog aborts the in-flight sign-in and stops the spawned agent.
 * Without `onFailed` a failure shows its reason here and the pick comes back.
 */
export function AntigravitySignInRun({
  account,
  onRunningChange,
  onSignedIn,
  onFailed,
  onCancel
}: {
  account: AntigravityAccountView
  onRunningChange?: (running: boolean) => void
  onSignedIn: () => void
  onFailed?: (reason: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [method, setMethod] = useState<string | null>(null)
  const [phase, setPhase] = useState<AntigravitySignInPhase>('starting')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  const cancel = (): void => {
    abortRef.current?.abort()
    abortRef.current = null
    onRunningChange?.(false)
    onCancel()
  }

  const start = async (methodId: string): Promise<void> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setMethod(methodId)
    setPhase('starting')
    setError(null)
    onRunningChange?.(true)
    try {
      await signInAntigravityAccount(account.id, methodId, {
        signal: controller.signal,
        onPhase: (nextPhase) => {
          if (mountedRef.current && abortRef.current === controller) {
            setPhase(nextPhase)
          }
        }
      })
      if (!mountedRef.current || abortRef.current !== controller) return
      abortRef.current = null
      onRunningChange?.(false)
      onSignedIn()
    } catch (err) {
      if (!mountedRef.current || abortRef.current !== controller) return
      abortRef.current = null
      onRunningChange?.(false)
      if (isAntigravitySignInCancelled(err) || controller.signal.aborted) {
        return
      }
      if (onFailed) {
        onFailed(accountErrorText(err))
        return
      }
      setError(accountErrorText(err))
      setMethod(null)
    }
  }

  return (
    <AntigravitySignInStep
      accountName={account.name}
      method={method}
      phase={phase}
      error={error}
      onPick={(methodId) => void start(methodId)}
      onCancel={cancel}
    />
  )
}
