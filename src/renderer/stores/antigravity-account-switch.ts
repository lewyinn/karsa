/**
 * Account switch for Antigravity chats. A copy of the Codex switch store.
 * After a Project's Antigravity Account changes, each open Antigravity chat of that
 * Project restarts on a fresh agent (the host starts it with the new home)
 * and resumes the same session. Idle chats restart at once; busy chats
 * after their turn ends. When the new Account cannot resume the session,
 * the chat continues in a new session with a summary handoff.
 */

import {
  ANTIGRAVITY_AGENT_CONFIG_ID,
  type RemovedAntigravityAccount
} from '@shared/types/antigravity-accounts.types'
import { toast } from 'sonner'
import {
  ownChatAccountId,
  projectAntigravityAccountId
} from '@/components/chat/antigravity-account/use-project-antigravity-account'
import { runningBackgroundCommands } from '@/components/chat/background-commands'
import { runningBackgroundSubagents } from '@/components/chat/subagent-strip'
import { acpApi } from '@/lib/acp-api'
import { resumeMissesSession } from '@/lib/acp-resume-policy'
import { antigravityAccountsApi } from '@/lib/antigravity-accounts-api'
import { logFrontendError } from '@/lib/log-api'
import { agentReuseKey, reuseScopeFor } from '@/stores/acp-reuse-keys'
import {
  type AcpState,
  BACKGROUND_COMMANDS_BLOCK_REASON,
  BACKGROUND_SUBAGENTS_BLOCK_REASON,
  historyOpenInFlight,
  isBackgroundWorkBlock,
  lastOwnUserPromptBlocks,
  renewAgentCredentials,
  runsCurrentLaunch,
  switchBlockedReason,
  useAcpStore
} from '@/stores/acp-store'
import { readOwnAntigravityChatAccount } from '@/stores/acp-store/chat-reuse-scope'
import { liveSiblingCount, reloadInFlight } from '@/stores/acp-store/reload-guard'
import { sessionAgentConfigId } from '@/stores/acp-store/session-agent-config'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import {
  isAntigravityAccountRestarting,
  setAntigravityAccountRestarting
} from '@/stores/antigravity-account-restart'
import { getAgentChatSessionIdsInAllTrees, useWorkspaceStore } from '@/stores/workspace-store'

export { ANTIGRAVITY_AGENT_CONFIG_ID }

export function isAntigravitySession(state: AcpState, sessionId: string): boolean {
  return sessionAgentConfigId(state, sessionId) === ANTIGRAVITY_AGENT_CONFIG_ID
}

export function runsProjectAccount(state: AcpState, sessionId: string): boolean {
  const session = state.sessions[sessionId]
  return runsCurrentLaunch(
    state,
    session.agentId,
    ANTIGRAVITY_AGENT_CONFIG_ID,
    session.cwd,
    session.projectId
  )
}

const isOpen = (state: AcpState, sessionId: string): boolean => {
  const status = state.sessions[sessionId]?.status
  return status === 'active' || status === 'error'
}

function openChatIds(): Set<string> {
  const ids = getAgentChatSessionIdsInAllTrees(useWorkspaceStore.getState())
  for (const kept of Object.values(useAgentChatLifetimeStore.getState().retainedByProject)) {
    for (const id of kept) ids.add(id)
  }
  return ids
}

async function stopOldAgent(agentId: string, reason: string): Promise<void> {
  void logFrontendError({
    level: 'info',
    source: 'antigravityAccountSwitch.stop',
    message: `Stopping agent ${agentId} (${reason}) without reopening its chats`
  })
  await useAcpStore
    .getState()
    .killAgent(agentId)
    .catch((error) => {
      void logFrontendError({
        level: 'warn',
        source: 'antigravityAccountSwitch.stop',
        message: `Stopping agent ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`
      })
    })
}

/**
 * Resolves once the chat has no turn, replay, queue, pending request or
 * running background subagent or command; `false` if it closed.
 * `ignoreBackground` does not wait for background subagents or commands: a
 * chat that continues after a limit must not wait on a command that may never
 * end, and `applyProjectAntigravityAccount` awaits that continue.
 */
function waitUntilIdle(sessionId: string, ignoreBackground: boolean): Promise<boolean> {
  const check = (state: AcpState): boolean | null => {
    if (!isOpen(state, sessionId)) return false
    const reason = switchBlockedReason(state, sessionId)
    if (reason === null) return true
    return ignoreBackground && isBackgroundWorkBlock(reason) ? true : null
  }
  const now = check(useAcpStore.getState())
  if (now !== null) return Promise.resolve(now)
  return new Promise((resolve) => {
    const unsubscribe = useAcpStore.subscribe((state) => {
      const result = check(state)
      if (result === null) return
      unsubscribe()
      resolve(result)
    })
  })
}

/** Move the live agent from one chat's reuse key to another's. */
function moveChatAgentKey(from: string, to: string, cwd: string, projectId: string): void {
  const fromKey = agentReuseKey(ANTIGRAVITY_AGENT_CONFIG_ID, cwd, projectId, from)
  const toKey = agentReuseKey(ANTIGRAVITY_AGENT_CONFIG_ID, cwd, projectId, to)
  useAcpStore.setState((s) => {
    const agentId = s.configToLiveAgent[fromKey]
    if (!agentId) return {}
    const { [fromKey]: _moved, ...rest } = s.configToLiveAgent
    return { configToLiveAgent: { ...rest, [toKey]: agentId } }
  })
}

/**
 * The new Account has no copy of the session (its home may not share
 * `antigravity-acp/conversations`): continue the chat in a new session that starts
 * from a summary, the same handoff as an agent switch (ADR-0004 fallback).
 * The new session keeps the chat's own Account, and the agent that was
 * already running that Account. Returns the new session id.
 */
async function continueInNewSession(sessionId: string, resend: boolean): Promise<string | null> {
  void logFrontendError({
    level: 'warn',
    source: 'antigravityAccountSwitch.handoff',
    message: `The account cannot resume chat ${sessionId}; continuing in a new session (resend=${resend})`
  })
  toast.info('This account could not resume the chat', {
    description: 'The chat continues in a new session that starts from a summary.'
  })
  const old = useAcpStore.getState().sessions[sessionId]
  const ownAccount = await readOwnAntigravityChatAccount(sessionId)
  const blocks = resend
    ? lastOwnUserPromptBlocks(useAcpStore.getState().messages[sessionId] ?? [])
    : null
  const newSessionId = await useAcpStore
    .getState()
    .switchAgent(sessionId, ANTIGRAVITY_AGENT_CONFIG_ID, {
      ...(blocks ? { wireBlocks: blocks, displayBlocks: blocks } : {}),
      accountChatId: reuseScopeFor(sessionId, ownAccount)
    })
  if (!newSessionId) return null
  const account =
    ownAccount === undefined ? await readOwnAntigravityChatAccount(sessionId) : ownAccount
  if (!account || !old?.projectId) return newSessionId
  const kept = await antigravityAccountsApi
    .setChatAccount(old.projectId, newSessionId, account)
    .catch((error) => (error instanceof Error ? error.message : String(error)))
  if (kept !== true) {
    void logFrontendError({
      level: 'warn',
      source: 'antigravityAccountSwitch.handoff',
      message: `Chat ${newSessionId} could not keep account ${account}: ${kept === false ? 'the host did not apply it' : kept}`
    })
    return newSessionId
  }
  moveChatAgentKey(sessionId, newSessionId, old.cwd, old.projectId)
  void logFrontendError({
    level: 'info',
    source: 'antigravityAccountSwitch.handoff',
    message: `Chat ${newSessionId} keeps account ${account} and the agent of chat ${sessionId}`
  })
  return newSessionId
}

/** Chats with a restart already running or waiting, so a second switch does not stack. */
/** One restart to run after the in-flight one, if the chat is still on the old account. */
const restartFollowUp = new Map<
  string,
  { resend?: boolean; cancelTurn?: boolean; notice?: string }
>()

/**
 * Restart one Antigravity chat on the Account it resolves to now and resume the
 * same session. `notice` is a new prompt once the chat runs again. `resend`
 * sends the last user prompt again. A limit switch uses `notice`, never
 * `resend`. `cancelTurn` stops a turn that is still held.
 */
export async function restartAntigravitySession(
  sessionId: string,
  options: { resend?: boolean; cancelTurn?: boolean; notice?: string } = {}
): Promise<boolean | 'notice-failed' | 'queued'> {
  if (isAntigravityAccountRestarting(sessionId)) {
    restartFollowUp.set(sessionId, options)
    return 'queued'
  }
  setAntigravityAccountRestarting(sessionId, true)
  let releasedShared = false
  try {
    const store = useAcpStore.getState()
    if (!isOpen(store, sessionId) || !isAntigravitySession(store, sessionId)) return false
    const blocked = switchBlockedReason(store, sessionId)
    if (options.cancelTurn && blocked !== null && !isBackgroundWorkBlock(blocked)) {
      await store.cancelPrompt(sessionId).catch(() => undefined)
    }
    if (!options.cancelTurn && blocked === BACKGROUND_SUBAGENTS_BLOCK_REASON) {
      const count = runningBackgroundSubagents(
        store.toolCalls[sessionId],
        store.messages[sessionId]
      ).length
      void logFrontendError({
        level: 'info',
        source: 'antigravityAccountSwitch.restart',
        message: `Restart of chat ${sessionId} waits on ${count} background subagent${count === 1 ? '' : 's'}`
      })
    }
    if (!options.cancelTurn && blocked === BACKGROUND_COMMANDS_BLOCK_REASON) {
      const count = runningBackgroundCommands(store.sessions[sessionId])
      void logFrontendError({
        level: 'info',
        source: 'antigravityAccountSwitch.restart',
        message: `Restart of chat ${sessionId} waits on ${count} background command${count === 1 ? '' : 's'}`
      })
    }
    // A chat that hit a limit continues now: its background subagents run on
    // the same exhausted account.
    if (!(await waitUntilIdle(sessionId, Boolean(options.cancelTurn)))) return false
    const oldAgentId = useAcpStore.getState().sessions[sessionId]?.agentId
    const shared =
      oldAgentId !== undefined &&
      liveSiblingCount(useAcpStore.getState().sessions, sessionId, oldAgentId) > 0
    if (!openChatIds().has(sessionId)) {
      if (oldAgentId && !shared) {
        await stopOldAgent(oldAgentId, `turn of unopened chat ${sessionId} ended`)
      }
      return false
    }
    void logFrontendError({
      level: 'info',
      source: 'antigravityAccountSwitch.restart',
      message: `Restarting chat ${sessionId} on its project account (resend=${Boolean(options.resend)}, shared agent=${shared})`
    })
    // Release the old process first so a web reopen cannot adopt it. Another
    // open chat on that process keeps it; only this chat's session closes.
    if (shared && oldAgentId) {
      reloadInFlight.add(sessionId)
      releasedShared = true
      await acpApi.closeSession(oldAgentId, sessionId).catch(() => undefined)
    } else if (oldAgentId) {
      await useAcpStore
        .getState()
        .killAgent(oldAgentId)
        .catch(() => undefined)
    }
    const resend = options.notice ? false : (options.resend ?? false)
    let continuedId = sessionId
    try {
      await useAcpStore.getState().retryCrashedSession(sessionId, { resend })
    } catch (error) {
      const stopped = useAcpStore.getState().sessions[sessionId]?.status === 'closed'
      if (!stopped || !resumeMissesSession(error)) throw error
      const created = await continueInNewSession(sessionId, resend)
      if (created) continuedId = created
    }
    useAcpStore.setState((s) => {
      const usage = s.sessionUsage[sessionId]
      if (!usage?.rateLimit) return {}
      const { rateLimit: _cleared, ...rest } = usage
      return { sessionUsage: { ...s.sessionUsage, [sessionId]: rest } }
    })
    const active = useAcpStore.getState().sessions[continuedId]?.status === 'active'
    if (active && options.notice) {
      // Composer sends are refused while this flag is set. Drop it for the
      // notice, then put it back so the cleanup below still owns the restart.
      setAntigravityAccountRestarting(sessionId, false)
      try {
        await useAcpStore.getState().sendPrompt(continuedId, options.notice)
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: 'antigravityAccountSwitch.restart',
          message: `Chat ${sessionId} restarted, but its continuation notice failed: ${error instanceof Error ? error.message : String(error)}`
        })
        return 'notice-failed'
      } finally {
        setAntigravityAccountRestarting(sessionId, true)
      }
    }
    return active
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'antigravityAccountSwitch.restart',
      message: `Restart of chat ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`
    })
    return false
  } finally {
    if (releasedShared) reloadInFlight.delete(sessionId)
    setAntigravityAccountRestarting(sessionId, false)
    const again = restartFollowUp.get(sessionId)
    if (again) {
      restartFollowUp.delete(sessionId)
      const state = useAcpStore.getState()
      if (isOpen(state, sessionId) && isAntigravitySession(state, sessionId)) {
        if (!runsProjectAccount(state, sessionId)) {
          await restartAntigravitySession(sessionId, again)
        } else if (again.notice && state.sessions[sessionId]?.status === 'active') {
          await useAcpStore
            .getState()
            .sendPrompt(sessionId, again.notice)
            .catch((error: unknown) => {
              void logFrontendError({
                level: 'warn',
                source: 'antigravityAccountSwitch.restart',
                message: `Chat ${sessionId} moved, but its continuation notice failed: ${error instanceof Error ? error.message : String(error)}`
              })
            })
        }
      }
    }
  }
}

async function restartAfterReopen(sessionId: string, projectId: string): Promise<void> {
  await historyOpenInFlight(sessionId)?.catch(() => undefined)
  const state = useAcpStore.getState()
  if (state.sessions[sessionId]?.projectId !== projectId) return
  if (!isAntigravitySession(state, sessionId) || runsProjectAccount(state, sessionId)) return
  void logFrontendError({
    level: 'info',
    source: 'antigravityAccountSwitch.apply',
    message: `Chat ${sessionId} reopened on an agent of the previous account; restarting it`
  })
  await restartAntigravitySession(sessionId)
}

/**
 * Restart every open Antigravity chat of a Project that follows the project after
 * its Account changed. A chat with its own Account stays. Busy chats restart
 * in the background when their turn ends. An unopened chat is not reopened.
 * The last prompt is not sent again.
 */
/**
 * Chats that own an Account. An empty set means none do, or the list could
 * not be read: a project change still restarts followers, because a missing
 * list is not proof that every chat is pinned.
 */
async function chatsWithOwnAccount(): Promise<Set<string>> {
  try {
    const snapshot = await antigravityAccountsApi.list()
    return new Set(
      Object.keys(snapshot.chatAccounts ?? {}).filter(
        (id) => ownChatAccountId(snapshot, id) !== null
      )
    )
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'antigravityAccountSwitch.apply',
      message: `Listing Antigravity accounts failed; restarting every follower of the project: ${error instanceof Error ? error.message : String(error)}`
    })
    return new Set()
  }
}

export async function applyProjectAntigravityAccount(
  projectId: string,
  options: { credentialsRenewed?: boolean } = {}
): Promise<void> {
  if (!options.credentialsRenewed) renewAgentCredentials(ANTIGRAVITY_AGENT_CONFIG_ID, projectId)
  const ownAccount = await chatsWithOwnAccount()
  const state = useAcpStore.getState()
  const openIds = openChatIds()
  const projectChats = Object.values(state.sessions).filter(
    (s) => s.projectId === projectId && isOpen(state, s.id) && isAntigravitySession(state, s.id)
  )
  const chats = projectChats.filter((s) => !ownAccount.has(s.id))
  const open = chats.filter((s) => openIds.has(s.id))
  const keptAgents = new Set(
    [...open, ...projectChats.filter((s) => ownAccount.has(s.id))].map((s) => s.agentId)
  )
  const unopened = chats.filter((s) => !openIds.has(s.id) && !keptAgents.has(s.agentId))
  const busy = unopened.filter((s) => switchBlockedReason(state, s.id) !== null)
  const busyAgents = new Set(busy.map((s) => s.agentId))
  const idleAgents = new Set(unopened.map((s) => s.agentId).filter((a) => !busyAgents.has(a)))
  const warm = new Set(Object.values(state.preparedSessions))
  const rewarmCwds = new Set<string>()
  for (const [key, sessionId] of Object.entries(state.preparedSessions)) {
    const [configId, cwd, mcpKey] = key.split('\0')
    if (configId !== ANTIGRAVITY_AGENT_CONFIG_ID || mcpKey || !cwd) continue
    if (state.sessions[sessionId]?.projectId === projectId) rewarmCwds.add(cwd)
  }
  void logFrontendError({
    level: 'info',
    source: 'antigravityAccountSwitch.apply',
    message: `Project ${projectId} account changed; restarting ${open.length} open Antigravity chats, stopping ${idleAgents.size} agents of unopened chats now (${unopened.filter((s) => warm.has(s.id)).length} warm-pool) and ${busy.length} after their turn, preparing ${rewarmCwds.size} warm sessions again`
  })
  const now: Promise<unknown>[] = []
  for (const agentId of idleAgents) now.push(stopOldAgent(agentId, 'chat not open'))
  for (const { id, agentId } of busy) {
    void logFrontendError({
      level: 'info',
      source: 'antigravityAccountSwitch.stop',
      message: `Agent ${agentId} of unopened chat ${id} stops after its running turn`
    })
    void restartAntigravitySession(id)
  }
  for (const id of Object.keys(state.openingHistoryIds)) {
    if (ownAccount.has(id)) continue
    void restartAfterReopen(id, projectId)
  }
  for (const cwd of rewarmCwds) {
    useAcpStore
      .getState()
      .prepareChat(ANTIGRAVITY_AGENT_CONFIG_ID, cwd, undefined, projectId, { silent: true })
  }
  for (const { id } of open) {
    if (switchBlockedReason(state, id) === null) now.push(restartAntigravitySession(id))
    else void restartAntigravitySession(id)
  }
  await Promise.all(now)
}

/**
 * Choose a Project's Account on the host, then restart the Antigravity chats that
 * follow the project. With `expectedAccountId` the host applies the choice
 * only while the Project still uses that Account. Resolves whether it applied.
 */
export async function switchProjectAntigravityAccount(
  projectId: string,
  accountId: string | null,
  options: { expectedAccountId?: string } = {}
): Promise<boolean> {
  renewAgentCredentials(ANTIGRAVITY_AGENT_CONFIG_ID, projectId)
  const applied = await antigravityAccountsApi.setProjectAccount(projectId, accountId, {
    expectedAccountId: options.expectedAccountId
  })
  if (!applied) return false
  await applyProjectAntigravityAccount(projectId, { credentialsRenewed: true })
  return true
}

/**
 * Restart the chats an Account removal moved: the open Antigravity chats of each
 * moved Project that follow it, and each chat that had the removed Account
 * as its own. Each runs the Account it resolves to now.
 */
export async function applyRemovedAntigravityAccount(
  removed: RemovedAntigravityAccount,
  followerProjectIds: readonly string[] = []
): Promise<void> {
  const projects = new Set([...removed.movedProjectIds, ...followerProjectIds])
  const sessions = useAcpStore.getState().sessions
  const chats = removed.movedChatIds.filter((id) => {
    const projectId = sessions[id]?.projectId
    return projectId !== undefined && !projects.has(projectId)
  })
  void logFrontendError({
    level: 'info',
    source: 'antigravityAccountSwitch.remove',
    message: `Antigravity account removed; restarting chats of ${projects.size} projects and ${chats.length} of ${removed.movedChatIds.length} chats that ran it as their own`
  })
  await Promise.all([
    ...[...projects].map((projectId) => applyProjectAntigravityAccount(projectId)),
    ...chats.map((id) => restartAntigravitySession(id))
  ])
}

export function chatSwitchNotice(from: string, to: string, window: string): string {
  return `You moved this chat from Antigravity account ${from} to ${to} because ${from} reached its ${window} limit. Continue the task you were working on. Subagents and background commands that were running before the switch were stopped; restart the ones that are still needed.`
}

export type ChatAccountSwitch =
  | 'unchanged'
  | 'kept'
  | 'lost'
  | 'restarted'
  | 'failed'
  | 'pending'
  | 'notice-failed'

export interface ChatSwitchToast {
  kind: 'success' | 'info' | 'error'
  title: string
  description?: string
}

export function chatSwitchToast(
  outcome: ChatAccountSwitch,
  target: string | null
): ChatSwitchToast | null {
  const now =
    target === null ? 'This chat follows the project again' : `This chat now uses ${target}`
  const to = target ?? 'the project account'
  switch (outcome) {
    case 'unchanged':
      return null
    case 'kept':
    case 'restarted':
      return { kind: 'success', title: now }
    case 'lost':
      return {
        kind: 'info',
        title: 'The account of this chat already changed',
        description: 'Karsa or another device switched it first.'
      }
    case 'pending':
      return { kind: 'info', title: `This chat moves to ${to} when its reply ends` }
    case 'failed':
      return {
        kind: 'error',
        title: `Could not restart this chat on ${to}`,
        description: 'Send a message to continue.'
      }
    case 'notice-failed':
      return {
        kind: 'error',
        title: 'The chat moved to the new account',
        description: 'The message asking it to continue was not sent. Send a message to continue.'
      }
  }
}

export function showChatSwitchToast(t: ChatSwitchToast | null): void {
  if (!t) return
  const show = t.kind === 'success' ? toast.success : t.kind === 'info' ? toast.info : toast.error
  if (t.description) show(t.title, { description: t.description })
  else show(t.title)
}

export async function switchChatAntigravityAccount(
  chat: {
    sessionId: string
    projectId: string
    runsOn: string
    ownAccountId: string | null
    projectAccountId: string
  },
  accountId: string | null,
  options: { notice?: string } = {}
): Promise<ChatAccountSwitch> {
  const { sessionId, projectId, runsOn } = chat
  if (accountId === chat.ownAccountId) return 'unchanged'
  const applied = await antigravityAccountsApi.setChatAccount(projectId, sessionId, accountId, {
    expectedAccountId: runsOn
  })
  if (!applied) return 'lost'
  let resolved = accountId ?? chat.projectAccountId
  if (accountId === null) {
    try {
      resolved = projectAntigravityAccountId(await antigravityAccountsApi.list(), projectId)
    } catch {
      resolved = chat.projectAccountId
    }
  }
  if (resolved === runsOn) return 'kept'
  const idle = switchBlockedReason(useAcpStore.getState(), sessionId) === null
  const restart = restartAntigravitySession(
    sessionId,
    options.notice ? { notice: options.notice, cancelTurn: true } : {}
  )
  if (!options.notice && !idle) {
    void restart
    return 'pending'
  }
  const outcome = await restart
  if (outcome === 'notice-failed') return 'notice-failed'
  if (outcome === 'queued') return 'pending'
  return outcome ? 'restarted' : 'failed'
}
