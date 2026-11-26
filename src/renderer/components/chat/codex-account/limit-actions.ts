import type { CodexLimitActionEvent } from '@shared/types/codex-accounts.types'
import { CODEX_AGENT_CONFIG_ID } from '@shared/types/codex-accounts.types'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { ACP_EVENTS, onAcpEvent } from '@/lib/acp-api'
import { notifyCodexAccountListChanged } from '@/lib/codex-account-list'
import { logFrontendError } from '@/lib/log-api'
import { agentReuseKey, reuseScopeFor } from '@/stores/acp-reuse-keys'
import { renewAgentCredentials, useAcpStore } from '@/stores/acp-store'
import { readOwnCodexChatAccount } from '@/stores/acp-store/chat-reuse-scope'
import { recordCurrentLaunch } from '@/stores/acp-store/shared-state'
import { useCodexResumeStore } from './use-codex-limit'

/** When the host continues each chat after its limit resets, epoch ms. */
export const useCodexResumeAt = create<Record<string, number>>(() => ({}))

function setResumeAt(sessionId: string, at: number | null): void {
  useCodexResumeAt.setState((state) => {
    const { [sessionId]: _done, ...rest } = state
    return at === null ? rest : { ...rest, [sessionId]: at }
  }, true)
  if (at === null) {
    useCodexResumeStore.getState().forget(sessionId)
    return
  }
  useCodexResumeStore.setState((state) => ({ at: { ...state.at, [sessionId]: at } }))
}

type FollowEvent = Extract<CodexLimitActionEvent, { action: 'switched' | 'resumed' }>

/**
 * Point the chat at the agent the host moved it to. A chat on its own Account
 * gets that agent under its reuse key, so a reopen finds it.
 */
function followAgent(event: FollowEvent): 'followed' | 'waiting' | 'stale' {
  const state = useAcpStore.getState()
  const session = state.sessions[event.sessionId]
  if (!session || event.fromAgentId === null || session.agentId !== event.fromAgentId)
    return 'stale'
  if (state.agentStatus[event.newAgentId] !== 'connected') return 'waiting'
  useAcpStore.setState((s) => {
    let sessionUsage = s.sessionUsage
    const usage = s.sessionUsage[event.sessionId]
    if (usage?.rateLimit) {
      const { rateLimit: _cleared, ...rest } = usage
      sessionUsage = { ...s.sessionUsage, [event.sessionId]: rest }
    }
    const chatKey = agentReuseKey(
      CODEX_AGENT_CONFIG_ID,
      session.cwd,
      session.projectId,
      event.sessionId
    )
    const ownKey = s.configToLiveAgent[chatKey] === event.fromAgentId
    return {
      sessions: {
        ...s.sessions,
        [event.sessionId]: { ...session, agentId: event.newAgentId, status: 'active' }
      },
      ...(ownKey
        ? { configToLiveAgent: { ...s.configToLiveAgent, [chatKey]: event.newAgentId } }
        : {}),
      sessionUsage
    }
  })
  return 'followed'
}

/** How long a follow waits for the host's new agent to connect here. */
export const FOLLOW_WAIT_MS = 60_000

const pendingFollows = new Map<
  string,
  { event: FollowEvent; timer: ReturnType<typeof setTimeout> }
>()
let stopWatching: (() => void) | null = null

function dropPending(sessionId: string): void {
  const pending = pendingFollows.get(sessionId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingFollows.delete(sessionId)
  if (pendingFollows.size === 0) {
    stopWatching?.()
    stopWatching = null
  }
}

async function keyFollowedAgent(event: FollowEvent): Promise<void> {
  const chatScope = reuseScopeFor(event.sessionId, await readOwnCodexChatAccount(event.sessionId))
  const session = useAcpStore.getState().sessions[event.sessionId]
  if (session?.agentId !== event.newAgentId) return
  if (chatScope === undefined && session.projectId) {
    renewAgentCredentials(CODEX_AGENT_CONFIG_ID, session.projectId)
  }
  recordCurrentLaunch(
    useAcpStore.getState(),
    event.newAgentId,
    CODEX_AGENT_CONFIG_ID,
    session.cwd,
    session.projectId
  )
  const key = agentReuseKey(CODEX_AGENT_CONFIG_ID, session.cwd, session.projectId, chatScope)
  useAcpStore.setState((s) => ({
    configToLiveAgent: { ...s.configToLiveAgent, [key]: event.newAgentId }
  }))
}

function followed(event: FollowEvent): void {
  if (event.action === 'switched') void keyFollowedAgent(event)
  void logFrontendError({
    level: 'info',
    source: 'codexLimit.follow',
    message: `Chat ${event.sessionId} follows host agent ${event.newAgentId} (${event.action})`
  })
  if (event.action === 'switched') {
    toast.success(`${event.from.name} reached its limit. Continued on ${event.to.name}.`)
  }
}

function retryPending(): void {
  for (const { event } of [...pendingFollows.values()]) {
    const outcome = followAgent(event)
    if (outcome === 'waiting') continue
    dropPending(event.sessionId)
    if (outcome === 'followed') followed(event)
  }
}

function follow(event: FollowEvent): void {
  dropPending(event.sessionId)
  const outcome = followAgent(event)
  if (outcome === 'followed') followed(event)
  if (outcome !== 'waiting') return
  const timer = setTimeout(() => {
    if (pendingFollows.get(event.sessionId)?.event !== event) return
    dropPending(event.sessionId)
    void logFrontendError({
      level: 'warn',
      source: 'codexLimit.follow',
      message: `Chat ${event.sessionId}: host agent ${event.newAgentId} did not connect here within ${FOLLOW_WAIT_MS} ms; stopped waiting`
    })
  }, FOLLOW_WAIT_MS)
  pendingFollows.set(event.sessionId, { event, timer })
  stopWatching ??= useAcpStore.subscribe(retryPending)
}

const reportedFailures = new Set<string>()

/** Apply one `acp:codex_limit_action`. `eventSeq` keeps a replayed failure from toasting twice. */
export function applyCodexLimitAction(event: CodexLimitActionEvent, eventSeq?: number): void {
  switch (event.action) {
    case 'resume_scheduled':
      setResumeAt(event.sessionId, event.at)
      return
    case 'resume_cancelled':
      setResumeAt(event.sessionId, null)
      return
    case 'failed': {
      setResumeAt(event.sessionId, null)
      if (eventSeq !== undefined) {
        const key = `${event.sessionId}:${eventSeq}`
        if (reportedFailures.has(key)) return
        reportedFailures.add(key)
      }
      toast.warning('Karsa could not continue the chat', { description: event.reason })
      return
    }
    case 'switched':
      setResumeAt(event.sessionId, null)
      notifyCodexAccountListChanged()
      follow(event)
      return
    case 'resumed':
      setResumeAt(event.sessionId, null)
      follow(event)
  }
}

/** Mount once per renderer root. */
export function useCodexLimitActions(): void {
  useEffect(
    () =>
      onAcpEvent<CodexLimitActionEvent>(ACP_EVENTS.codexLimitAction, (event, eventSeq) =>
        applyCodexLimitAction(event, eventSeq)
      ),
    []
  )
}
