/**
 * 1-click Reset Context for any active AI chat tab.
 *
 * - When the active agent advertises `/clear` (e.g. Claude Code, Karsa Custom API),
 *   sends `/clear` directly in the current session.
 * - Otherwise (e.g. Antigravity, Codex, OpenCode), opens a brand-new clean session
 *   on the same agent, workspace, model, and mode, then remaps the current chat tab
 *   in place (`remapAgentChatSession`) so the user never loses their tab or selections.
 */

import { toast } from 'sonner'
import type { AvailableCommand } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { type AcpSession, useAcpStore } from '@/stores/acp-store'
import { agentChatTabId, findPaneContainingTab, useWorkspaceStore } from '@/stores/workspace-store'

export interface ResetContextParams {
  session: AcpSession
  commands: readonly AvailableCommand[]
  onSend: (text: string) => void
}

export async function resetSessionContext({
  session,
  commands,
  onSend
}: ResetContextParams): Promise<void> {
  if (session.activeTurn || session.status !== 'active') return

  const hasClearCommand = commands.some((cmd) => cmd.name === 'clear')
  if (hasClearCommand) {
    void logFrontendError({
      level: 'info',
      source: 'ContextReset',
      message: `Resetting context via /clear on session ${session.id}`
    })
    onSend('/clear')
    toast.success('Context reset')
    return
  }

  const acp = useAcpStore.getState()
  const prevModelId = session.models?.currentModelId ?? null
  const prevModeId = session.modes?.currentModeId ?? null

  const newSessionId = await acp.createSession(
    session.agentId,
    session.cwd,
    undefined,
    session.projectId,
    {
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch
    }
  )

  if (prevModelId) {
    await acp.setModel(newSessionId, prevModelId).catch(() => {})
  }
  if (prevModeId) {
    await acp.setMode(newSessionId, prevModeId).catch(() => {})
  }

  const ws = useWorkspaceStore.getState()
  if (findPaneContainingTab(ws.root, agentChatTabId(session.id))) {
    ws.remapAgentChatSession(session.id, newSessionId)
  }

  void logFrontendError({
    level: 'info',
    source: 'ContextReset',
    message: `Reset context by starting fresh session ${newSessionId} in place of ${session.id}`
  })
  toast.success('Context reset — started fresh in this tab')
}
