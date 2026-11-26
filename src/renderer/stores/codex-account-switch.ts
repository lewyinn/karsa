/**
 * Account switch for Codex chats. A copy of the Claude switch store.
 * After a Project's Codex Account changes, each open Codex chat of that
 * Project restarts on a fresh agent (the host starts it with the new home)
 * and resumes the same session. Idle chats restart at once; busy chats
 * after their turn ends. When the new Account cannot resume the session,
 * the chat continues in a new session with a summary handoff.
 */

import type { RemovedCodexAccount } from '@shared/types/codex-accounts.types'
import { toast } from 'sonner'
import { runningBackgroundCommands } from '@/components/chat/background-commands'
import {
  ownChatAccountId,
  projectCodexAccountId
} from '@/components/chat/codex-account/use-project-codex-account'
import { runningBackgroundSubagents } from '@/components/chat/subagent-strip'
import { acpApi } from '@/lib/acp-api'
import { resumeMissesSession } from '@/lib/acp-resume-policy'
import { codexAccountsApi } from '@/lib/codex-accounts-api'
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
import { readOwnCodexChatAccount } from '@/stores/acp-store/chat-reuse-scope'
import { liveSiblingCount, reloadInFlight } from '@/stores/acp-store/reload-guard'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { isCodexAccountRestarting, setCodexAccountRestarting } from '@/stores/codex-account-restart'
import { getAgentChatSessionIdsInAllTrees, useWorkspaceStore } from '@/stores/workspace-store'

/** Config id of the host-managed Codex ACP agent. */
export const CODEX_AGENT_CONFIG_ID = 'acp-registry:codex-acp'

/** The agent config of a chat: the live reuse-key map first, then the session index. */
export function sessionAgentConfigId(state: AcpState, sessionId: string): string | null {
  const session = state.sessions?.[sessionId]
  if (session?.agentId) {
    for (const [key, id] of Object.entries(state.configToLiveAgent ?? {})) {
      if (id === session.agentId) return key.split('\0')[0] ?? null
    }
  }
  return state.sessionIndex?.find((entry) => entry.id === sessionId)?.agentConfigId ?? null
}

export function isCodexSession(state: AcpState, sessionId: string): boolean {
  return sessionAgentConfigId(state, sessionId) === CODEX_AGENT_CONFIG_ID
}

export function runsProjectAccount(state: AcpState, sessionId: string): boolean {
  const session = state.sessions[sessionId]
  return runsCurrentLaunch(
    state,
    session.agentId,
    CODEX_AGENT_CONFIG_ID,
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
    source: 'codexAccountSwitch.stop',
    message: `Stopping agent ${agentId} (${reason}) without reopening its chats`
  })
  await useAcpStore
    .getState()
    .killAgent(agentId)
    .catch((error) => {
      void logFrontendError({
        level: 'warn',
        source: 'codexAccountSwitch.stop',
        message: `Stopping agent ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`
      })
    })
}

/**
 * Resolves once the chat has no turn, replay, queue, pending request or
 * running background subagent or command; `false` if it closed.
 * `ignoreBackground` does not wait for background subagents or commands: a
 * chat that continues after a limit must not wait on a command that may never
 * end, and `applyProjectCodexAccount` awaits that continue.
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
  const fromKey = agentReuseKey(CODEX_AGENT_CONFIG_ID, cwd, projectId, from)
  const toKey = agentReuseKey(CODEX_AGENT_CONFIG_ID, cwd, projectId, to)
  useAcpStore.setState((s) => {
    const agentId = s.configToLiveAgent[fromKey]
    if (!agentId) return {}
    const { [fromKey]: _moved, ...rest } = s.configToLiveAgent
    return { configToLiveAgent: { ...rest, [toKey]: agentId } }
  })
}

/**
 * The new Account has no copy of the session (on Windows its config directory
 * may not share `projects`): continue the chat in a new session that starts
 * from a summary, the same handoff as an agent switch (ADR-0004 fallback).
 * The new session keeps the chat's own Account, and the agent that was
 * already running that Account. Returns the new session id.
 */
async function continueInNewSession(sessionId: string, resend: boolean): Promise<string | null> {
  void logFrontendError({
    level: 'warn',
    source: 'codexAccountSwitch.handoff',
    message: `The account cannot resume chat ${sessionId}; continuing in a new session (resend=${resend})`
  })
  toast.info('This account could not resume the chat', {
    description: 'The chat continues in a new session that starts from a summary.'
  })
  const old = useAcpStore.getState().sessions[sessionId]
  const ownAccount = await readOwnCodexChatAccount(sessionId)
  const blocks = resend
    ? lastOwnUserPromptBlocks(useAcpStore.getState().messages[sessionId] ?? [])
    : null
  const newSessionId = await useAcpStore.getState().switchAgent(sessionId, CODEX_AGENT_CONFIG_ID, {
    ...(blocks ? { wireBlocks: blocks, displayBlocks: blocks } : {}),
    accountChatId: reuseScopeFor(sessionId, ownAccount)
  })
  if (!newSessionId) return null
  const account = ownAccount === undefined ? await readOwnCodexChatAccount(sessionId) : ownAccount
  if (!account || !old?.projectId) return newSessionId
  const kept = await codexAccountsApi
    .setChatAccount(old.projectId, newSessionId, account)
    .catch((error) => (error instanceof Error ? error.message : String(error)))
  if (kept !== true) {
    void logFrontendError({
      level: 'warn',
      source: 'codexAccountSwitch.handoff',
      message: `Chat ${newSessionId} could not keep account ${account}: ${kept === false ? 'the host did not apply it' : kept}`
    })
    return newSessionId
  }
  moveChatAgentKey(sessionId, newSessionId, old.cwd, old.projectId)
  void logFrontendError({
    level: 'info',
    source: 'codexAccountSwitch.handoff',
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
 * Restart one Codex chat on the Account it resolves to now and resume the
 * same session. `notice` is a new prompt once the chat runs again. `resend`
 * sends the last user prompt again. A limit switch uses `notice`, never
 * `resend`. `cancelTurn` stops a turn that is still held.
 */
export async function restartCodexSession(
  sessionId: string,
  options: { resend?: boolean; cancelTurn?: boolean; notice?: string } = {}
): Promise<boolean | 'notice-failed' | 'queued'> {
  if (isCodexAccountRestarting(sessionId)) {
    restartFollowUp.set(sessionId, options)
    return 'queued'
  }
  setCodexAccountRestarting(sessionId, true)
  let releasedShared = false
  try {
    const store = useAcpStore.getState()
    if (!isOpen(store, sessionId) || !isCodexSession(store, sessionId)) return false
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
        source: 'codexAccountSwitch.restart',
        message: `Restart of chat ${sessionId} waits on ${count} background subagent${count === 1 ? '' : 's'}`
      })
    }
    if (!options.cancelTurn && blocked === BACKGROUND_COMMANDS_BLOCK_REASON) {
      const count = runningBackgroundCommands(store.sessions[sessionId])
      void logFrontendError({
        level: 'info',
        source: 'codexAccountSwitch.restart',
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
      source: 'codexAccountSwitch.restart',
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
      setCodexAccountRestarting(sessionId, false)
      try {
        await useAcpStore.getState().sendPrompt(continuedId, options.notice)
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: 'codexAccountSwitch.restart',
          message: `Chat ${sessionId} restarted, but its continuation notice failed: ${error instanceof Error ? error.message : String(error)}`
        })
        return 'notice-failed'
      } finally {
        setCodexAccountRestarting(sessionId, true)
      }
    }
    return active
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'codexAccountSwitch.restart',
      message: `Restart of chat ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`
    })
    return false
  } finally {
    if (releasedShared) reloadInFlight.delete(sessionId)
    setCodexAccountRestarting(sessionId, false)
    const again = restartFollowUp.get(sessionId)
    if (again) {
      restartFollowUp.delete(sessionId)
      const state = useAcpStore.getState()
      if (isOpen(state, sessionId) && isCodexSession(state, sessionId)) {
        if (!runsProjectAccount(state, sessionId)) {
          await restartCodexSession(sessionId, again)
        } else if (again.notice && state.sessions[sessionId]?.status === 'active') {
          await useAcpStore
            .getState()
            .sendPrompt(sessionId, again.notice)
            .catch((error: unknown) => {
              void logFrontendError({
                level: 'warn',
                source: 'codexAccountSwitch.restart',
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
  if (!isCodexSession(state, sessionId) || runsProjectAccount(state, sessionId)) return
  void logFrontendError({
    level: 'info',
    source: 'codexAccountSwitch.apply',
    message: `Chat ${sessionId} reopened on an agent of the previous account; restarting it`
  })
  await restartCodexSession(sessionId)
}

/**
 * Restart every open Codex chat of a Project that follows the project after
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
    const snapshot = await codexAccountsApi.list()
    return new Set(
      Object.keys(snapshot.chatAccounts ?? {}).filter(
        (id) => ownChatAccountId(snapshot, id) !== null
      )
    )
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'codexAccountSwitch.apply',
      message: `Listing Codex accounts failed; restarting every follower of the project: ${error instanceof Error ? error.message : String(error)}`
    })
    return new Set()
  }
}

export async function applyProjectCodexAccount(
  projectId: string,
  options: { credentialsRenewed?: boolean } = {}
): Promise<void> {
  if (!options.credentialsRenewed) renewAgentCredentials(CODEX_AGENT_CONFIG_ID, projectId)
  const ownAccount = await chatsWithOwnAccount()
  const state = useAcpStore.getState()
  const openIds = openChatIds()
  const projectChats = Object.values(state.sessions).filter(
    (s) => s.projectId === projectId && isOpen(state, s.id) && isCodexSession(state, s.id)
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
    if (configId !== CODEX_AGENT_CONFIG_ID || mcpKey || !cwd) continue
    if (state.sessions[sessionId]?.projectId === projectId) rewarmCwds.add(cwd)
  }
  void logFrontendError({
    level: 'info',
    source: 'codexAccountSwitch.apply',
    message: `Project ${projectId} account changed; restarting ${open.length} open Codex chats, stopping ${idleAgents.size} agents of unopened chats now (${unopened.filter((s) => warm.has(s.id)).length} warm-pool) and ${busy.length} after their turn, preparing ${rewarmCwds.size} warm sessions again`
  })
  const now: Promise<unknown>[] = []
  for (const agentId of idleAgents) now.push(stopOldAgent(agentId, 'chat not open'))
  for (const { id, agentId } of busy) {
    void logFrontendError({
      level: 'info',
      source: 'codexAccountSwitch.stop',
      message: `Agent ${agentId} of unopened chat ${id} stops after its running turn`
    })
    void restartCodexSession(id)
  }
  for (const id of Object.keys(state.openingHistoryIds)) {
    if (ownAccount.has(id)) continue
    void restartAfterReopen(id, projectId)
  }
  for (const cwd of rewarmCwds) {
    useAcpStore
      .getState()
      .prepareChat(CODEX_AGENT_CONFIG_ID, cwd, undefined, projectId, { silent: true })
  }
  for (const { id } of open) {
    if (switchBlockedReason(state, id) === null) now.push(restartCodexSession(id))
    else void restartCodexSession(id)
  }
  await Promise.all(now)
}

/**
 * Choose a Project's Account on the host, then restart the Codex chats that
 * follow the project. With `expectedAccountId` the host applies the choice
 * only while the Project still uses that Account. Resolves whether it applied.
 */
export async function switchProjectCodexAccount(
  projectId: string,
  accountId: string | null,
  options: { expectedAccountId?: string } = {}
): Promise<boolean> {
  renewAgentCredentials(CODEX_AGENT_CONFIG_ID, projectId)
  const applied = await codexAccountsApi.setProjectAccount(projectId, accountId, {
    expectedAccountId: options.expectedAccountId
  })
  if (!applied) return false
  await applyProjectCodexAccount(projectId, { credentialsRenewed: true })
  return true
}

/**
 * Restart the chats an Account removal moved: the open Codex chats of each
 * moved Project that follow it, and each chat that had the removed Account
 * as its own. Each runs the Account it resolves to now.
 */
export async function applyRemovedCodexAccount(
  removed: RemovedCodexAccount,
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
    source: 'codexAccountSwitch.remove',
    message: `Codex account removed; restarting chats of ${projects.size} projects and ${chats.length} of ${removed.movedChatIds.length} chats that ran it as their own`
  })
  await Promise.all([
    ...[...projects].map((projectId) => applyProjectCodexAccount(projectId)),
    ...chats.map((id) => restartCodexSession(id))
  ])
}

export function chatSwitchNotice(from: string, to: string, window: string): string {
  return `You moved this chat from Codex account ${from} to ${to} because ${from} reached its ${window} limit. Continue the task you were working on. Subagents and background commands that were running before the switch were stopped; restart the ones that are still needed.`
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

export async function switchChatCodexAccount(
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
  const applied = await codexAccountsApi.setChatAccount(projectId, sessionId, accountId, {
    expectedAccountId: runsOn
  })
  if (!applied) return 'lost'
  let resolved = accountId ?? chat.projectAccountId
  if (accountId === null) {
    try {
      resolved = projectCodexAccountId(await codexAccountsApi.list(), projectId)
    } catch {
      resolved = chat.projectAccountId
    }
  }
  if (resolved === runsOn) return 'kept'
  const idle = switchBlockedReason(useAcpStore.getState(), sessionId) === null
  const restart = restartCodexSession(
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
