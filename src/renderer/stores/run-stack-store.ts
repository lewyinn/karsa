import type { DiscoveredGitRepo } from '@shared/types/ipc.types'
import { type LastSelectedAgent, PersistenceKeys } from '@shared/types/persistence.types'
import { toast } from 'sonner'
import { create } from 'zustand'
import { launchChat } from '@/components/agents/launcher/launch-chat'
import { openNewChat } from '@/components/chat/new-chat/open-new-chat'
import { seedComposerDraft } from '@/components/chat/use-composer-draft'
import { persistenceApi, terminalApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import {
  buildFixInChatPrompt,
  discoverStackServices,
  type StackServiceConfig
} from '@/lib/stack-discovery'
import { spawnTerminalInPane } from '@/lib/terminal-spawn'
import { useAcpStore } from '@/stores/acp-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { getAllLeafPanes } from '@/stores/workspace-store/tree'

const STORAGE_KEY = 'karsa:run-stack:v1'

interface PersistedProjectStack {
  customServices: StackServiceConfig[]
  commandOverrides: Record<string, string>
}

type PersistedStackMap = Record<string, PersistedProjectStack>

function readPersisted(): PersistedStackMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as PersistedStackMap) : {}
  } catch {
    return {}
  }
}

function writePersisted(data: PersistedStackMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // Ignore storage quota errors in restricted webviews.
  }
}

function serviceKey(projectId: string, serviceId: string): string {
  return `${projectId}::${serviceId}`
}

function targetPaneId(): string | null {
  const ws = useWorkspaceStore.getState()
  if (ws.activePaneId) return ws.activePaneId
  if (!ws.root) return null
  return getAllLeafPanes(ws.root)[0]?.id ?? null
}

async function resolveDefaultAgentConfigId(): Promise<string | null> {
  const configs = useAcpStore.getState().agentConfigs
  if (configs.length === 0) return null
  const saved = await persistenceApi
    .read<LastSelectedAgent>(PersistenceKeys.lastSelectedAgent)
    .catch(() => null)
  const savedId = saved?.success && saved.data?.mode === 'acp' ? saved.data.agentId : null
  return configs.find((config) => config.id === savedId)?.id ?? configs[0].id
}

interface RunStackState {
  discoveredByProject: Record<string, StackServiceConfig[]>
  persistedByProject: PersistedStackMap
  loadingByProject: Record<string, boolean>
  terminalByServiceKey: Record<string, string>

  discover: (
    projectId: string,
    rootPath: string,
    repos?: readonly DiscoveredGitRepo[]
  ) => Promise<void>
  addCustomService: (projectId: string, service: Omit<StackServiceConfig, 'id' | 'custom'>) => void
  removeCustomService: (projectId: string, serviceId: string) => void
  setCommandOverride: (projectId: string, serviceId: string, command: string) => void
  startService: (projectId: string, service: StackServiceConfig) => Promise<boolean>
  stopService: (projectId: string, serviceId: string) => Promise<void>
  restartService: (projectId: string, service: StackServiceConfig) => Promise<void>
  startAll: (projectId: string, services: readonly StackServiceConfig[]) => Promise<void>
  stopAll: (projectId: string, services: readonly StackServiceConfig[]) => Promise<void>
  focusServiceTerminal: (projectId: string, serviceId: string) => void
  fixServiceInChat: (projectId: string, service: StackServiceConfig) => Promise<void>
}

export function mergeProjectServices(
  discovered: readonly StackServiceConfig[],
  persisted: PersistedProjectStack | undefined
): StackServiceConfig[] {
  const overrides = persisted?.commandOverrides ?? {}
  const base = discovered.map((service) =>
    overrides[service.id] ? { ...service, command: overrides[service.id] } : service
  )
  const custom = (persisted?.customServices ?? []).map((service) =>
    overrides[service.id] ? { ...service, command: overrides[service.id] } : service
  )
  return [...base, ...custom]
}

export const useRunStackStore = create<RunStackState>((set, get) => ({
  discoveredByProject: {},
  persistedByProject: typeof window !== 'undefined' ? readPersisted() : {},
  loadingByProject: {},
  terminalByServiceKey: {},

  discover: async (projectId, rootPath, repos = []) => {
    if (!projectId || !rootPath) return
    set((state) => ({
      loadingByProject: { ...state.loadingByProject, [projectId]: true }
    }))
    try {
      const services = await discoverStackServices(rootPath, repos)
      set((state) => ({
        discoveredByProject: { ...state.discoveredByProject, [projectId]: services },
        loadingByProject: { ...state.loadingByProject, [projectId]: false }
      }))
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'run-stack-store',
        message: `Service discovery failed for ${rootPath}: ${String(err)}`
      })
      set((state) => ({
        loadingByProject: { ...state.loadingByProject, [projectId]: false }
      }))
    }
  },

  addCustomService: (projectId, input) => {
    const id = `custom:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
    const nextService: StackServiceConfig = { ...input, id, custom: true }
    set((state) => {
      const current = state.persistedByProject[projectId] ?? {
        customServices: [],
        commandOverrides: {}
      }
      const nextPersisted: PersistedStackMap = {
        ...state.persistedByProject,
        [projectId]: {
          ...current,
          customServices: [...current.customServices, nextService]
        }
      }
      writePersisted(nextPersisted)
      return { persistedByProject: nextPersisted }
    })
  },

  removeCustomService: (projectId, serviceId) => {
    set((state) => {
      const current = state.persistedByProject[projectId]
      if (!current) return state
      const { [serviceId]: _removed, ...restOverrides } = current.commandOverrides
      const nextPersisted: PersistedStackMap = {
        ...state.persistedByProject,
        [projectId]: {
          customServices: current.customServices.filter((s) => s.id !== serviceId),
          commandOverrides: restOverrides
        }
      }
      writePersisted(nextPersisted)
      return { persistedByProject: nextPersisted }
    })
  },

  setCommandOverride: (projectId, serviceId, command) => {
    const trimmed = command.trim()
    if (!trimmed) return
    set((state) => {
      const current = state.persistedByProject[projectId] ?? {
        customServices: [],
        commandOverrides: {}
      }
      const nextPersisted: PersistedStackMap = {
        ...state.persistedByProject,
        [projectId]: {
          ...current,
          commandOverrides: { ...current.commandOverrides, [serviceId]: trimmed }
        }
      }
      writePersisted(nextPersisted)
      return { persistedByProject: nextPersisted }
    })
  },

  startService: async (projectId, service) => {
    const key = serviceKey(projectId, service.id)
    const existingTerminalId = get().terminalByServiceKey[key]
    const terminals = useTerminalStore.getState().terminals
    const existing = existingTerminalId
      ? terminals.find((t) => t.id === existingTerminalId)
      : undefined

    // If a terminal for this service is already live & running, focus it.
    if (
      existing?.ptyId &&
      (existing.lastExitCode === null || existing.lastExitCode === undefined)
    ) {
      get().focusServiceTerminal(projectId, service.id)
      return true
    }

    const paneId = targetPaneId()
    if (!paneId) {
      toast.error('No workspace pane available to start service')
      return false
    }

    const spawned = await spawnTerminalInPane(paneId, projectId, service.cwd, {
      name: `Stack: ${service.name}`
    })
    if (!spawned.success || !spawned.terminalId) {
      toast.error(spawned.error || `Failed to start ${service.name}`)
      return false
    }

    const created = useTerminalStore.getState().terminals.find((t) => t.id === spawned.terminalId)
    set((state) => ({
      terminalByServiceKey: {
        ...state.terminalByServiceKey,
        [key]: spawned.terminalId as string
      }
    }))

    if (created?.ptyId) {
      const ptyId = created.ptyId
      // Give the shell a brief moment to emit its initial prompt before sending the command.
      setTimeout(() => {
        void terminalApi.write(ptyId, `${service.command}\r`).catch((err) => {
          void logFrontendError({
            level: 'warn',
            source: 'run-stack-store',
            message: `Failed to write start command for ${service.name}: ${String(err)}`
          })
        })
      }, 250)
    }

    toast.success(`Started ${service.name}`)
    return true
  },

  stopService: async (projectId, serviceId) => {
    const key = serviceKey(projectId, serviceId)
    const terminalId = get().terminalByServiceKey[key]
    if (!terminalId) return
    const terminal = useTerminalStore.getState().terminals.find((t) => t.id === terminalId)
    if (!terminal?.ptyId) return

    const ptyId = terminal.ptyId
    try {
      await terminalApi.write(ptyId, '\x03').catch(() => {})
      await terminalApi.kill(ptyId)
      useTerminalStore.getState().updateTerminalExitCode(terminal.id, 0)
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'run-stack-store',
        message: `Failed to stop service ${serviceId}: ${String(err)}`
      })
      toast.error(`Failed to stop service: ${String(err)}`)
    }
  },

  restartService: async (projectId, service) => {
    await get().stopService(projectId, service.id)
    set((state) => {
      const next = { ...state.terminalByServiceKey }
      delete next[serviceKey(projectId, service.id)]
      return { terminalByServiceKey: next }
    })
    await get().startService(projectId, service)
  },

  startAll: async (projectId, services) => {
    for (const service of services) {
      await get().startService(projectId, service)
    }
  },

  stopAll: async (projectId, services) => {
    await Promise.all(services.map((service) => get().stopService(projectId, service.id)))
    toast.success('Stopped all running stack services')
  },

  focusServiceTerminal: (projectId, serviceId) => {
    const key = serviceKey(projectId, serviceId)
    const terminalId = get().terminalByServiceKey[key]
    if (!terminalId) return

    const terminalStore = useTerminalStore.getState()
    const terminal = terminalStore.terminals.find((t) => t.id === terminalId)
    if (!terminal) return
    terminalStore.selectTerminal(terminalId)

    const ws = useWorkspaceStore.getState()
    if (!ws.root) return
    for (const pane of getAllLeafPanes(ws.root)) {
      const tab = pane.tabs.find((t) => t.type === 'terminal' && t.terminalId === terminalId)
      if (tab) {
        ws.setActiveTab(pane.id, tab.id)
        ws.setActivePane(pane.id)
        return
      }
    }
  },

  fixServiceInChat: async (projectId, service) => {
    const key = serviceKey(projectId, service.id)
    const terminalId = get().terminalByServiceKey[key]
    const terminalStore = useTerminalStore.getState()
    const terminal = terminalId
      ? terminalStore.terminals.find((t) => t.id === terminalId)
      : undefined
    const transcript = terminal?.ptyId ? terminalStore.peekTranscript(terminal.ptyId) : ''
    const prompt = buildFixInChatPrompt(service, transcript, terminal?.lastExitCode ?? null)

    const configId = await resolveDefaultAgentConfigId()
    if (!configId) {
      toast.error('Select an AI agent first to troubleshoot in Chat')
      void openNewChat({ projectId, reason: 'menu' })
      return
    }

    let draftSeeded = false
    const seedDraft = (sessionId: string) => {
      if (draftSeeded) return
      draftSeeded = true
      seedComposerDraft(projectId, sessionId, prompt)
    }

    try {
      const { started } = launchChat({
        configId,
        projectId,
        surface: { kind: 'pane' },
        checkout: { launchCwd: service.cwd },
        onAdopt: (_from, to) => seedDraft(to)
      })
      const sessionId = await started
      seedDraft(sessionId)
      toast.success(`Opened chat with ${service.name} logs`)
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'run-stack-store',
        message: `Fix in chat failed for ${service.name}: ${String(err)}`
      })
      toast.error('Failed to open troubleshooting chat')
    }
  }
}))
