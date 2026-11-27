/**
 * Sign an Antigravity Account in with ACP `authenticate` on an agent whose
 * `GEMINI_HOME` is that Account. `oauth-personal` signs in with a Google
 * account, `oauth-business` with Gemini Enterprise. Both open the Google page
 * through the agent browser-auth flow, so they work on the desktop app and on
 * a remote browser. API-key and Agent Platform auth are not offered.
 */

import {
  ANTIGRAVITY_AGENT_CONFIG_ID,
  ANTIGRAVITY_BUSINESS_METHOD,
  ANTIGRAVITY_GOOGLE_METHOD
} from '@shared/types/antigravity-accounts.types'
import type { AgentConfig } from '@/lib/acp-api'
import { antigravityAccountsApi } from '@/lib/antigravity-accounts-api'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { refreshAntigravityAfterSettingsSignIn } from '@/stores/acp-store/post-auth-refresh'

export const ANTIGRAVITY_SIGN_IN_METHODS = [
  { id: ANTIGRAVITY_GOOGLE_METHOD, label: 'Log in with Google' },
  { id: ANTIGRAVITY_BUSINESS_METHOD, label: 'Log in with Gemini Enterprise' }
] as const

export type AntigravitySignInPhase = 'starting' | 'waiting_browser'

export interface SignInAntigravityOptions {
  signal?: AbortSignal
  onPhase?: (phase: AntigravitySignInPhase) => void
}

export class AntigravitySignInCancelledError extends Error {
  constructor() {
    super('Sign-in was cancelled.')
    this.name = 'AntigravitySignInCancelledError'
  }
}

export function isAntigravitySignInCancelled(error: unknown): boolean {
  return error instanceof AntigravitySignInCancelledError
}

export function isAntigravitySignInMethod(methodId: string): boolean {
  return methodId === ANTIGRAVITY_GOOGLE_METHOD || methodId === ANTIGRAVITY_BUSINESS_METHOD
}

export function antigravityLaunchConfig(): AgentConfig {
  const stored = useAcpStore
    .getState()
    .agentConfigs.find((config) => config.id === ANTIGRAVITY_AGENT_CONFIG_ID)
  if (!stored) {
    throw new Error('The Antigravity agent is not set up on this host.')
  }
  return {
    configId: ANTIGRAVITY_AGENT_CONFIG_ID,
    name: stored.name,
    command: stored.command,
    args: stored.args ?? [],
    env: { ...(stored.env ?? {}) },
    allowTerminal: stored.allowTerminal
  }
}

/**
 * Spawn, authenticate, then stop the sign-in agent. The Google login stays in
 * the Account home. Passing an `AbortSignal` lets the user cancel while the
 * agent is booting or waiting for Google sign-in, immediately stopping the
 * spawned process.
 */
export async function signInAntigravityAccount(
  accountId: string,
  methodId: string,
  options?: SignInAntigravityOptions
): Promise<void> {
  if (!isAntigravitySignInMethod(methodId)) {
    throw new Error('Antigravity accounts sign in with Google only.')
  }
  const signal = options?.signal
  if (signal?.aborted) {
    throw new AntigravitySignInCancelledError()
  }
  const config = antigravityLaunchConfig()
  options?.onPhase?.('starting')
  const startPromise = antigravityAccountsApi.startLogin(accountId, config)

  // If the user cancels while `agy_acp_server` is still booting (which can
  // take 15–25s on Windows), reject immediately so the dialog closes right
  // away and kill the spawned process as soon as `startLogin` settles.
  let result: Awaited<typeof startPromise>
  if (signal) {
    let onStartAbort: (() => void) | null = null
    try {
      result = await new Promise<Awaited<typeof startPromise>>((resolve, reject) => {
        onStartAbort = () => {
          reject(new AntigravitySignInCancelledError())
        }
        if (signal.aborted) {
          onStartAbort()
          return
        }
        signal.addEventListener('abort', onStartAbort, { once: true })
        startPromise.then(resolve, reject)
      })
    } catch (err) {
      if (isAntigravitySignInCancelled(err)) {
        void logFrontendError({
          level: 'info',
          source: 'antigravityAccounts.signIn',
          message: `Antigravity account ${accountId} sign-in cancelled while starting (${methodId})`
        })
        void startPromise
          .then((late) => {
            useAcpStore.getState().clearPendingSignIn?.(late.agentId)
            return useAcpStore
              .getState()
              .killAgent(late.agentId)
              .catch(() => undefined)
          })
          .catch(() => undefined)
      }
      throw err
    } finally {
      if (onStartAbort) signal.removeEventListener('abort', onStartAbort)
    }
  } else {
    result = await startPromise
  }

  useAcpStore.setState((state) => ({
    agents: {
      ...state.agents,
      [result.agentId]: {
        id: result.agentId,
        capabilities: result.capabilities ?? null,
        authMethods: result.authMethods ?? [],
        hostAuthReady: false
      }
    },
    agentStatus: { ...state.agentStatus, [result.agentId]: 'connected' }
  }))

  let signedIn = false
  let killPromise: Promise<unknown> | null = null
  const stopAgent = (): Promise<unknown> => {
    if (!killPromise) {
      useAcpStore.getState().clearPendingSignIn?.(result.agentId)
      killPromise = useAcpStore
        .getState()
        .killAgent(result.agentId)
        .catch(() => undefined)
    }
    return killPromise
  }

  let onAuthAbort: (() => void) | null = null
  try {
    if (signal?.aborted) {
      throw new AntigravitySignInCancelledError()
    }
    options?.onPhase?.('waiting_browser')
    const authPromise = useAcpStore.getState().authenticateAgent(result.agentId, methodId)
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        onAuthAbort = () => {
          void stopAgent()
          reject(new AntigravitySignInCancelledError())
        }
        if (signal.aborted) {
          onAuthAbort()
          return
        }
        signal.addEventListener('abort', onAuthAbort, { once: true })
        authPromise.then(
          () => resolve(),
          (err) => reject(err)
        )
      })
    } else {
      await authPromise
    }
    signedIn = true
    void logFrontendError({
      level: 'info',
      source: 'antigravityAccounts.signIn',
      message: `Antigravity account ${accountId} finished Google sign-in (${methodId})`
    })
  } catch (err) {
    if (isAntigravitySignInCancelled(err)) {
      void logFrontendError({
        level: 'info',
        source: 'antigravityAccounts.signIn',
        message: `Antigravity account ${accountId} sign-in cancelled while waiting (${methodId})`
      })
    }
    throw err
  } finally {
    if (signal && onAuthAbort) signal.removeEventListener('abort', onAuthAbort)
    await stopAgent()
  }
  if (signedIn) {
    // Trigger `session/new` on the active/failed Antigravity workspaces so the
    // model list populates immediately without requiring an app restart.
    void refreshAntigravityAfterSettingsSignIn(useAcpStore.getState)
  }
}
