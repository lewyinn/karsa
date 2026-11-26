import {
  ANTIGRAVITY_AGENT_CONFIG_ID,
  ANTIGRAVITY_BUSINESS_METHOD,
  ANTIGRAVITY_GOOGLE_METHOD
} from '@shared/types/antigravity-accounts.types'
import type { AgentId } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { useProjectStore } from '@/stores/project-store'
import { isDetachedReuseKey, parseReuseKey } from '../acp-reuse-keys'
import { prepareChatKey } from './helpers'
import { ephemeralSessionIds, inFlightPrepared } from './shared-state'
import type { AcpSession, AcpState } from './types'

interface PrepareTarget {
  cwd: string
  projectId: string
}

/**
 * True when an ACP `authenticate` completion should automatically re-run
 * `session/new` (`prepareChat`) and verify the advertised model catalog
 * without requiring an app restart.
 */
export function isOAuthPersonalRefreshTarget(
  configId: string | null | undefined,
  methodId: string
): boolean {
  return (
    configId === ANTIGRAVITY_AGENT_CONFIG_ID ||
    methodId === ANTIGRAVITY_GOOGLE_METHOD ||
    methodId === ANTIGRAVITY_BUSINESS_METHOD
  )
}

/**
 * Mirrors `catalogFromSessionState` in the model selector: true when a live
 * session advertises at least one model via `models.availableModels` or a
 * `category: 'model'` config option.
 */
export function sessionHasAdvertisedModels(session: AcpSession | undefined): boolean {
  if (!session) return false
  if ((session.models?.availableModels?.length ?? 0) > 0) return true
  return session.configOptions.some(
    (option) =>
      option.category === 'model' &&
      typeof option.currentValue === 'string' &&
      (option.options?.length ?? 0) > 0
  )
}

function collectTargetsForConfig(
  state: AcpState,
  configId: string,
  agentId?: AgentId
): PrepareTarget[] {
  const byKey = new Map<string, PrepareTarget>()
  const addTarget = (cwd: string | undefined, projectId: string | undefined): void => {
    const trimmed = cwd?.trim()
    const resolvedProject = projectId?.trim()
    if (!trimmed || !resolvedProject) return
    const key = `${trimmed}\0${resolvedProject}`
    if (!byKey.has(key)) byKey.set(key, { cwd: trimmed, projectId: resolvedProject })
  }

  const projects = useProjectStore.getState().projects
  const activeProjectId = useProjectStore.getState().activeProjectId
  const activeProject = projects.find((project) => project.id === activeProjectId)

  for (const [reuseKey, liveId] of Object.entries(state.configToLiveAgent)) {
    if (isDetachedReuseKey(reuseKey)) continue
    const parsed = parseReuseKey(reuseKey)
    if (agentId ? liveId !== agentId : parsed.configId !== configId) continue
    const resolvedProjectId =
      parsed.projectId ??
      projects.find((project) => project.path === parsed.cwd)?.id ??
      activeProjectId ??
      undefined
    addTarget(parsed.cwd, resolvedProjectId)
  }

  for (const [errKey, err] of Object.entries(state.prepareChatErrors)) {
    const parsed = parseReuseKey(errKey)
    if (parsed.configId !== configId) continue
    if (err.category !== 'auth' && err.category !== 'multi-auth') continue
    const resolvedProjectId =
      projects.find((project) => project.path === parsed.cwd)?.id ?? activeProjectId ?? undefined
    addTarget(parsed.cwd, resolvedProjectId)
  }

  if (byKey.size === 0 && activeProject?.path) {
    addTarget(activeProject.path, activeProject.id)
  }

  return [...byKey.values()]
}

async function runFreshPrepare(
  get: () => AcpState,
  configId: string,
  target: PrepareTarget
): Promise<{ key: string; sessionId: string | null }> {
  const key = prepareChatKey(configId, target.cwd, undefined)
  get().cancelPreparedChat(key)
  get().prepareChat(configId, target.cwd, undefined, target.projectId)
  const pending = inFlightPrepared.get(key)
  const sessionId = pending ? await pending : (get().preparedSessions[key] ?? null)
  return { key, sessionId }
}

/**
 * Re-run `session/new` via `prepareChat` immediately after an `oauth-personal`
 * (or Antigravity) `authenticate` succeeds so the model catalog loads without
 * needing a restart. If the existing agent process still fails `session/new`
 * or returns an empty model catalog after auth, evict it once and retry on a
 * fresh process that picks up the newly written OAuth token file.
 */
export async function refreshSessionsAfterOAuthPersonal(
  get: () => AcpState,
  params: {
    agentId: AgentId
    configId: string
    methodId: string
    evictAgent?: (agentId: AgentId) => Promise<void>
  }
): Promise<void> {
  const { agentId, configId, methodId, evictAgent } = params
  const targets = collectTargetsForConfig(get(), configId, agentId)
  if (targets.length === 0) return

  void logFrontendError({
    level: 'info',
    source: 'acp-store.postAuthRefresh',
    message: `Auth (${methodId}) finished for ${configId}; re-running session/new for ${targets.length} workspace(s) to load models`
  })

  let restartedAgent = false
  for (const target of targets) {
    const first = await runFreshPrepare(get, configId, target)
    const firstSession = first.sessionId ? get().sessions[first.sessionId] : undefined
    if (first.sessionId && sessionHasAdvertisedModels(firstSession)) continue

    if (!restartedAgent) {
      restartedAgent = true
      void logFrontendError({
        level: 'info',
        source: 'acp-store.postAuthRefresh',
        message: `session/new after ${methodId} on ${agentId} did not populate models; restarting agent process once to reload credentials and model catalog`
      })
      if (evictAgent) {
        await evictAgent(agentId)
      } else {
        await get()
          .killAgent(agentId)
          .catch(() => undefined)
      }
      const second = await runFreshPrepare(get, configId, target)
      const secondSession = second.sessionId ? get().sessions[second.sessionId] : undefined
      if (!second.sessionId || !sessionHasAdvertisedModels(secondSession)) {
        void logFrontendError({
          level: 'warn',
          source: 'acp-store.postAuthRefresh',
          message: `session/new retry after ${methodId} for ${configId} still returned no models`
        })
      }
    }
  }
}

/**
 * Called after Settings → Provider → Antigravity finishes signing an account
 * in via a temporary sign-in agent process. Stops idle/unauthenticated live
 * Antigravity processes so they pick up the new OAuth token, clears stale auth
 * errors, and triggers `prepareChat` (`session/new`) to populate the model list.
 */
export async function refreshAntigravityAfterSettingsSignIn(get: () => AcpState): Promise<void> {
  const state = get()
  const hasConfig = state.agentConfigs.some((c) => c.id === ANTIGRAVITY_AGENT_CONFIG_ID)
  if (!hasConfig) return

  const targets = collectTargetsForConfig(state, ANTIGRAVITY_AGENT_CONFIG_ID)
  const agentsToRestart = new Set<AgentId>()
  for (const [reuseKey, liveId] of Object.entries(state.configToLiveAgent)) {
    if (isDetachedReuseKey(reuseKey)) continue
    if (parseReuseKey(reuseKey).configId !== ANTIGRAVITY_AGENT_CONFIG_ID) continue
    const hasActiveUserChat = Object.values(state.sessions).some(
      (session) =>
        session.agentId === liveId &&
        session.status !== 'closed' &&
        !ephemeralSessionIds.has(session.id)
    )
    if (!hasActiveUserChat) {
      agentsToRestart.add(liveId)
    }
  }

  for (const liveId of agentsToRestart) {
    await get()
      .killAgent(liveId)
      .catch(() => undefined)
  }

  if (targets.length === 0) return

  void logFrontendError({
    level: 'info',
    source: 'acp-store.postAuthRefresh',
    message: `Antigravity settings sign-in finished; re-running session/new for ${targets.length} workspace(s) to load models`
  })

  for (const target of targets) {
    await runFreshPrepare(get, ANTIGRAVITY_AGENT_CONFIG_ID, target)
  }
}
