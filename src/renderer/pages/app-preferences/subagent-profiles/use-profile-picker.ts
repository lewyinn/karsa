import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLauncherSelectorSource } from '@/components/agents/launcher/use-launcher-selector-source'
import {
  overlayPendingLauncherOptions,
  pendingWithModel
} from '@/components/agents/pending-launcher-options'
import { armableConfigId } from '@/components/chat/agent-model-selector/selector-model'
import type { SelectorSource } from '@/components/chat/agent-model-selector/selector-source'
import type { SwitchModelPick } from '@/components/chat/agent-model-selector/use-agent-switch'
import {
  type ComposerOptionControls,
  composerOptionControls
} from '@/components/chat/chat-input-bar-config'
import { useResolvedSupportedAcpAgents } from '@/hooks/use-resolved-supported-acp-agents'
import type { SessionModeState, SubagentProfile } from '@/lib/acp-api'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { logFrontendError } from '@/lib/log-api'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { type AcpSession, useAcpStore } from '@/stores/acp-store'
import type { OptionValues } from '@/stores/acp-store/composer-options'
import { prepareChatKey } from '@/stores/acp-store/helpers'
import { useProjectStore } from '@/stores/project-store'
import { pendingOf, withAgent, withPending, withSavedValues } from './profile-model'

const NO_UPDATES: ReadonlySet<string> = new Set()
const noop = (): void => {}

const NO_PROJECT: PrepareChatError = {
  category: 'unknown',
  label: 'Open a project to load models',
  detail: 'Karsa starts the agent in the open project to read its models.'
}

/** A change to a profile, applied to the profile as it is when the change is sent. */
export type EditProfile = (profile: SubagentProfile) => SubagentProfile

/** Everything the profile row's model chip and Mode row need. */
export interface ProfilePicker extends ComposerOptionControls {
  source: SelectorSource
  agentName: string | null
  agentTemplateId: string | null
  agentIcon: string | null
  /** The agent's modes with the profile's mode current; null when it lists none. */
  modes: SessionModeState | null
  /** A session-shaped holder of `modes` for the mode menu. */
  modeSession: AcpSession | null
  onSetModel: (modelId: string, values?: OptionValues) => Promise<void>
  onSetConfig: (configId: string, value: string | boolean) => Promise<void>
  onSetMode: (modeId: string) => Promise<void>
  onOpenChange: (open: boolean) => void
}

/**
 * The composer's model picker for one sub-agent profile, with no session: the
 * agent's last known options (the options cache, filled from its saved model
 * list or a warm prepare) with the profile's saved model, mode and option
 * values on top. Picks save the profile; a tab moves it to that agent. Opening
 * the picker prepares the agent in the open project, as the launcher does, so
 * its live models, thinking levels and modes load.
 */
export function useProfilePicker({
  profile,
  launchableAgentIds,
  pinned,
  edit
}: {
  profile: SubagentProfile
  /** The agents the host can start; the picker's tabs. */
  launchableAgentIds: ReadonlySet<string>
  /** The profile cannot move to another agent, so the picker offers only its own. */
  pinned: boolean
  edit: (change: EditProfile) => Promise<void>
}): ProfilePicker {
  const agentId = profile.agentId
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const supported = useResolvedSupportedAcpAgents(agentConfigs)
  const tabId = useCallback(
    (entry: SupportedAcpAgentEntry) => armableConfigId(entry, agentConfigs) ?? entry.configId,
    [agentConfigs]
  )
  const entries = useMemo(
    () =>
      supported.filter((entry) =>
        pinned ? tabId(entry) === agentId : launchableAgentIds.has(tabId(entry))
      ),
    [supported, launchableAgentIds, tabId, pinned, agentId]
  )
  const selectedEntry = entries.find((entry) => tabId(entry) === agentId) ?? null
  const config = agentConfigs.find((candidate) => candidate.id === agentId) ?? null

  const projectId = useProjectStore((s) => s.activeProjectId) ?? ''
  const cwd = projectId ? getDefaultCwdForProject(projectId) : ''
  const key = cwd ? prepareChatKey(agentId, cwd, undefined) : null
  const preparing = useAcpStore((s) => (key ? Boolean(s.preparingChatKeys[key]) : false))
  const prepareError = useAcpStore((s) => (key ? (s.prepareChatErrors[key] ?? null) : null))
  const cache = useAcpStore((s) => s.agentOptionsCache[agentId] ?? null)

  const effective = useMemo(
    () =>
      overlayPendingLauncherOptions({
        ...withSavedValues(
          {
            models: cache?.models ?? null,
            modes: cache?.modes ?? null,
            configOptions: cache?.configOptions ?? []
          },
          profile
        ),
        pending: pendingOf(profile)
      }),
    [cache, profile]
  )
  const controls = composerOptionControls(effective)
  const hasModels = controls.modelOption !== null

  const prepare = useCallback(() => {
    if (!cwd) return
    void logFrontendError({
      level: 'info',
      source: 'subagentProfiles.loadModels',
      message: `Starting ${agentId} silently in ${cwd} to read its models`
    })
    useAcpStore.getState().prepareChat(agentId, cwd, undefined, projectId, { silent: true })
  }, [agentId, cwd, projectId])
  const retry = useCallback(() => {
    if (key) useAcpStore.getState().cancelPreparedChat(key)
    prepare()
  }, [key, prepare])

  // While the picker is open, its agent is prepared once (a tab pick moves the
  // profile to another agent, which is prepared then).
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open || !key) return
    const s = useAcpStore.getState()
    if (s.preparedSessions[key] || s.preparingChatKeys[key] || s.prepareChatErrors[key]) return
    prepare()
  }, [open, key, prepare])

  useEffect(() => {
    if (!prepareError) return
    void logFrontendError({
      level: 'warn',
      source: 'subagentProfiles.loadModels',
      message: `Could not read models for ${agentId}: ${prepareError.label}: ${prepareError.detail}`
    })
  }, [prepareError, agentId])

  const error = prepareError ?? (!cwd && !hasModels ? NO_PROJECT : null)
  const source = useLauncherSelectorSource({
    paneKey: `subagent-profile-${profile.id}`,
    supportedAgents: entries,
    agentConfigs,
    selectedEntry,
    installingConfigId: null,
    cwd,
    projectId,
    onSelectAgent: (entry) => {
      const next = tabId(entry)
      if (next !== agentId) void edit((current) => withAgent(current, next)).catch(noop)
    },
    onSelectAgentWithModel: (entry, pick: SwitchModelPick) => {
      const configValues: Record<string, string> = { ...pick.values }
      if (pick.modelConfigId) configValues[pick.modelConfigId] = pick.modelId
      const next = tabId(entry)
      void edit((current) =>
        withAgent(current, next, { modelId: pick.modelId, configValues })
      ).catch(noop)
    },
    onInstall: noop,
    showModelLoading: !prepareError && preparing && !hasModels,
    prepareError: error,
    hasCachedModels: hasModels,
    canSignIn: false,
    onSignIn: noop,
    onRetry: prepareError ? retry : noop,
    updateAgentIds: NO_UPDATES
  })

  const { modelOption, modelSource } = controls
  const onSetModel = useCallback(
    (modelId: string, values?: OptionValues) => {
      const modelConfigId = modelSource === 'config' ? (modelOption?.id ?? null) : null
      return edit((current) =>
        withPending(
          current,
          pendingWithModel(
            pendingOf(current),
            modelId,
            values ?? {},
            modelConfigId,
            effective.configOptions
          )
        )
      )
    },
    [modelSource, modelOption, effective.configOptions, edit]
  )
  const onSetConfig = useCallback(
    (configId: string, value: string | boolean) => {
      if (modelSource === 'config' && configId === modelOption?.id && typeof value === 'string') {
        return onSetModel(value)
      }
      const stored = typeof value === 'boolean' ? String(value) : value
      return edit((current) => ({
        ...current,
        configOptions: { ...current.configOptions, [configId]: stored }
      }))
    },
    [modelSource, modelOption, onSetModel, edit]
  )
  const onSetMode = useCallback(
    (modeId: string) => edit((current) => ({ ...current, mode: modeId })),
    [edit]
  )

  const modes =
    effective.modes && effective.modes.availableModes.length > 0 ? effective.modes : null
  const modeSession = useMemo(
    (): AcpSession | null =>
      modes
        ? {
            id: `subagent-profile-${profile.id}`,
            agentId: '',
            cwd,
            projectId,
            status: 'initializing',
            title: null,
            activeTurn: false,
            openTurnId: null,
            modes,
            models: effective.models,
            configOptions: effective.configOptions,
            lastError: null,
            createdAt: 0
          }
        : null,
    [modes, profile.id, cwd, projectId, effective.models, effective.configOptions]
  )

  return {
    ...controls,
    source,
    agentName: config?.name ?? selectedEntry?.agent.name ?? null,
    agentTemplateId: config?.templateId ?? selectedEntry?.agent.id ?? null,
    agentIcon: config?.icon ?? null,
    modes,
    modeSession,
    onSetModel,
    onSetConfig,
    onSetMode,
    onOpenChange: setOpen
  }
}
