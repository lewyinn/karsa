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
 * the Account home. The browser sign-in dialog shows the Google page while
 * `authenticate` waits.
 */
export async function signInAntigravityAccount(accountId: string, methodId: string): Promise<void> {
  if (!isAntigravitySignInMethod(methodId)) {
    throw new Error('Antigravity accounts sign in with Google only.')
  }
  const config = antigravityLaunchConfig()
  const result = await antigravityAccountsApi.startLogin(accountId, config)
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
  try {
    await useAcpStore.getState().authenticateAgent(result.agentId, methodId)
    signedIn = true
    void logFrontendError({
      level: 'info',
      source: 'antigravityAccounts.signIn',
      message: `Antigravity account ${accountId} finished Google sign-in (${methodId})`
    })
  } finally {
    await useAcpStore
      .getState()
      .killAgent(result.agentId)
      .catch(() => undefined)
  }
  if (signedIn) {
    // Trigger `session/new` on the active/failed Antigravity workspaces so the
    // model list populates immediately without requiring an app restart.
    void refreshAntigravityAfterSettingsSignIn(useAcpStore.getState)
  }
}
