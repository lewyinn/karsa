import { ANTIGRAVITY_AGENT_CONFIG_ID } from '@shared/types/antigravity-accounts.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import { agentReuseKey } from '../acp-reuse-keys'
import { prepareChatKey } from './helpers'
import {
  isOAuthPersonalRefreshTarget,
  refreshAntigravityAfterSettingsSignIn,
  refreshSessionsAfterOAuthPersonal,
  sessionHasAdvertisedModels
} from './post-auth-refresh'
import { ephemeralSessionIds, inFlightPrepared } from './shared-state'
import type { AcpSession, AcpState } from './types'

function makeSession(overrides: Partial<AcpSession> = {}): AcpSession {
  return {
    id: 'session-1',
    agentId: 'agent-1',
    cwd: '/workspace/karsa',
    projectId: 'proj-1',
    status: 'active',
    title: null,
    activeTurn: false,
    agentWorking: false,
    mcpServerCount: 0,
    openTurnId: null,
    modes: null,
    models: null,
    configOptions: [],
    lastError: null,
    createdAt: Date.now(),
    replaying: null,
    ...overrides
  }
}

describe('post-auth-refresh (antigravity-acp oauth-personal)', () => {
  beforeEach(() => {
    inFlightPrepared.clear()
    ephemeralSessionIds.clear()
    useProjectStore.setState({
      projects: [
        {
          id: 'proj-1',
          name: 'Karsa',
          path: '/workspace/karsa',
          color: 'blue',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      activeProjectId: 'proj-1'
    })
  })

  it('targets antigravity-acp and oauth-personal / oauth-business methods', () => {
    expect(isOAuthPersonalRefreshTarget(ANTIGRAVITY_AGENT_CONFIG_ID, 'oauth-personal')).toBe(true)
    expect(isOAuthPersonalRefreshTarget('custom-agent', 'oauth-personal')).toBe(true)
    expect(isOAuthPersonalRefreshTarget('custom-agent', 'oauth-business')).toBe(true)
    expect(isOAuthPersonalRefreshTarget('acp-registry:codex-acp', 'chatgpt')).toBe(false)
  })

  it('detects models from both availableModels and model configOptions', () => {
    expect(sessionHasAdvertisedModels(makeSession())).toBe(false)
    expect(
      sessionHasAdvertisedModels(
        makeSession({
          models: {
            currentModelId: 'gemini-2.5-pro',
            availableModels: [{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]
          }
        })
      )
    ).toBe(true)
    expect(
      sessionHasAdvertisedModels(
        makeSession({
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gemini-2.5-pro',
              options: [{ value: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]
            }
          ]
        })
      )
    ).toBe(true)
  })

  it('re-runs session/new immediately after oauth-personal and keeps the agent when models load', async () => {
    const cwd = '/workspace/karsa'
    const key = prepareChatKey(ANTIGRAVITY_AGENT_CONFIG_ID, cwd, undefined)
    const reuseKey = agentReuseKey(ANTIGRAVITY_AGENT_CONFIG_ID, cwd, 'proj-1')
    const killAgent = vi.fn().mockResolvedValue(undefined)
    const cancelPreparedChat = vi.fn()
    const state = {
      agentConfigs: [
        { id: ANTIGRAVITY_AGENT_CONFIG_ID, name: 'Antigravity', command: 'agy_acp_server' }
      ],
      configToLiveAgent: { [reuseKey]: 'agent-1' },
      prepareChatErrors: {
        [key]: { category: 'auth', label: 'Sign-in required', detail: 'Auth required' }
      },
      preparedSessions: {} as Record<string, string>,
      sessions: {} as Record<string, AcpSession>,
      killAgent,
      cancelPreparedChat,
      prepareChat: vi.fn(() => {
        const session = makeSession({
          id: 'session-after-auth',
          agentId: 'agent-1',
          models: {
            currentModelId: 'gemini-2.5-pro',
            availableModels: [{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]
          }
        })
        state.sessions[session.id] = session
        state.preparedSessions[key] = session.id
        inFlightPrepared.set(key, Promise.resolve(session.id))
      })
    } as unknown as AcpState

    await refreshSessionsAfterOAuthPersonal(() => state, {
      agentId: 'agent-1',
      configId: ANTIGRAVITY_AGENT_CONFIG_ID,
      methodId: 'oauth-personal'
    })

    expect(cancelPreparedChat).toHaveBeenCalledWith(key)
    expect(state.prepareChat).toHaveBeenCalledTimes(1)
    expect(state.prepareChat).toHaveBeenCalledWith(
      ANTIGRAVITY_AGENT_CONFIG_ID,
      cwd,
      undefined,
      'proj-1'
    )
    expect(killAgent).not.toHaveBeenCalled()
  })

  it('restarts the agent once and retries session/new when the first post-auth prepare returns no models', async () => {
    const cwd = '/workspace/karsa'
    const key = prepareChatKey(ANTIGRAVITY_AGENT_CONFIG_ID, cwd, undefined)
    const reuseKey = agentReuseKey(ANTIGRAVITY_AGENT_CONFIG_ID, cwd, 'proj-1')
    const killAgent = vi.fn().mockResolvedValue(undefined)
    const cancelPreparedChat = vi.fn()
    let attempt = 0
    const state = {
      agentConfigs: [
        { id: ANTIGRAVITY_AGENT_CONFIG_ID, name: 'Antigravity', command: 'agy_acp_server' }
      ],
      configToLiveAgent: { [reuseKey]: 'agent-old' },
      prepareChatErrors: {},
      preparedSessions: {} as Record<string, string>,
      sessions: {} as Record<string, AcpSession>,
      killAgent,
      cancelPreparedChat,
      prepareChat: vi.fn(() => {
        attempt += 1
        if (attempt === 1) {
          // Old process returned a session with no models yet.
          const empty = makeSession({ id: 'session-empty', agentId: 'agent-old', models: null })
          state.sessions[empty.id] = empty
          state.preparedSessions[key] = empty.id
          inFlightPrepared.set(key, Promise.resolve(empty.id))
        } else {
          const fresh = makeSession({
            id: 'session-fresh',
            agentId: 'agent-fresh',
            models: {
              currentModelId: 'gemini-2.5-pro',
              availableModels: [{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]
            }
          })
          state.sessions[fresh.id] = fresh
          state.preparedSessions[key] = fresh.id
          inFlightPrepared.set(key, Promise.resolve(fresh.id))
        }
      })
    } as unknown as AcpState

    await refreshSessionsAfterOAuthPersonal(() => state, {
      agentId: 'agent-old',
      configId: ANTIGRAVITY_AGENT_CONFIG_ID,
      methodId: 'oauth-personal'
    })

    expect(killAgent).toHaveBeenCalledTimes(1)
    expect(killAgent).toHaveBeenCalledWith('agent-old')
    expect(state.prepareChat).toHaveBeenCalledTimes(2)
    expect(state.preparedSessions[key]).toBe('session-fresh')
  })

  it('restarts idle Antigravity processes and prepares active workspace after Settings sign-in', async () => {
    const cwd = '/workspace/karsa'
    const key = prepareChatKey(ANTIGRAVITY_AGENT_CONFIG_ID, cwd, undefined)
    const reuseKey = agentReuseKey(ANTIGRAVITY_AGENT_CONFIG_ID, cwd, 'proj-1')
    const killAgent = vi.fn().mockResolvedValue(undefined)
    const cancelPreparedChat = vi.fn()
    const prepareChat = vi.fn(() => {
      inFlightPrepared.set(key, Promise.resolve('session-from-settings'))
    })
    const state = {
      agentConfigs: [
        { id: ANTIGRAVITY_AGENT_CONFIG_ID, name: 'Antigravity', command: 'agy_acp_server' }
      ],
      configToLiveAgent: { [reuseKey]: 'agent-idle' },
      prepareChatErrors: {
        [key]: { category: 'auth', label: 'Sign-in required', detail: 'Not signed in' }
      },
      preparedSessions: {},
      sessions: {},
      killAgent,
      cancelPreparedChat,
      prepareChat
    } as unknown as AcpState

    await refreshAntigravityAfterSettingsSignIn(() => state)

    expect(killAgent).toHaveBeenCalledWith('agent-idle')
    expect(cancelPreparedChat).toHaveBeenCalledWith(key)
    expect(prepareChat).toHaveBeenCalledWith(ANTIGRAVITY_AGENT_CONFIG_ID, cwd, undefined, 'proj-1')
  })
})
