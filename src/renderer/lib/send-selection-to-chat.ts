import { toast } from 'sonner'
import { seedComposerDraft } from '@/components/chat/use-composer-draft'
import { logFrontendError } from '@/lib/log-api'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'
import type { PaneNode } from '@/types/workspace.types'

export const APPEND_COMPOSER_DRAFT_EVENT = 'karsa:append-composer-draft'
export const EDITOR_SEND_SELECTION_EVENT = 'karsa:editor-send-selection'

export interface AppendComposerDraftDetail {
  projectId: string | null
  sessionId: string | null
  text: string
}

export interface SendSelectionInput {
  filePath: string
  startLine: number
  endLine: number
  selectedText: string
  language?: string
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

function relativeDisplayPath(filePath: string, projectRoot?: string | null): string {
  const normFile = normalizeSlashes(filePath)
  if (projectRoot) {
    const normRoot = normalizeSlashes(projectRoot).replace(/\/$/, '')
    if (normFile.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
      return normFile.slice(normRoot.length + 1)
    }
  }
  return normFile.split('/').pop() || normFile
}

function fenceLang(filePath: string, language?: string): string {
  if (language && language !== 'plaintext' && language !== 'text') return language
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return /^[a-z0-9_+-]{1,16}$/.test(ext) ? ext : ''
}

export function formatEditorSelectionSnippet(
  input: SendSelectionInput,
  projectRoot?: string | null
): { snippet: string; locationLabel: string } {
  const rel = relativeDisplayPath(input.filePath, projectRoot)
  const lineRange =
    input.endLine > input.startLine
      ? `L${input.startLine}-L${input.endLine}`
      : `L${input.startLine}`
  const locationLabel = `${rel}:${input.startLine}${input.endLine > input.startLine ? `-${input.endLine}` : ''}`
  const lang = fenceLang(input.filePath, input.language)
  const code = input.selectedText.replace(/\r\n/g, '\n').trimEnd()
  const snippet = code
    ? `\`${rel}#${lineRange}\`\n\`\`\`${lang}\n${code}\n\`\`\``
    : `\`${rel}#${lineRange}\``
  return { snippet, locationLabel }
}

type AgentChatTab = Extract<WorkspaceTab, { type: 'agent-chat' }>

function findAgentChatTab(node: PaneNode): { paneId: string; tab: AgentChatTab } | null {
  if (node.type === 'leaf') {
    const active = node.tabs.find((t) => t.id === node.activeTabId)
    if (active?.type === 'agent-chat') return { paneId: node.id, tab: active }
    const anyChat = node.tabs.find((t): t is AgentChatTab => t.type === 'agent-chat')
    if (anyChat) return { paneId: node.id, tab: anyChat }
    return null
  }
  for (const child of node.children) {
    const found = findAgentChatTab(child)
    if (found) return found
  }
  return null
}

/**
 * Insert the active editor selection into the open AI Chat composer (or seed
 * the chat draft) and focus that chat tab so the user can type their question.
 */
export function sendSelectionToAiChat(input: SendSelectionInput): void {
  const projectState = useProjectStore.getState()
  const activeProject = projectState.projects.find((p) => p.id === projectState.activeProjectId)
  const { snippet, locationLabel } = formatEditorSelectionSnippet(input, activeProject?.path)

  const workspace = useWorkspaceStore.getState()
  const found = findAgentChatTab(workspace.root)
  const sessionId = found?.tab.sessionId ?? null
  const projectId = activeProject?.id ?? null

  if (found) {
    workspace.setActiveTab(found.paneId, found.tab.id)
  }

  if (projectId && sessionId) {
    seedComposerDraft(projectId, sessionId, `${snippet}\n\n`)
  }

  window.dispatchEvent(
    new CustomEvent<AppendComposerDraftDetail>(APPEND_COMPOSER_DRAFT_EVENT, {
      detail: {
        projectId,
        sessionId,
        text: `${snippet}\n\n`
      }
    })
  )

  void logFrontendError({
    level: 'info',
    source: 'editor.sendSelectionToAiChat',
    message: `Sent editor selection (${locationLabel}) to AI Chat`
  })
  toast.success(`Sent to AI Chat: ${locationLabel}`)
}
