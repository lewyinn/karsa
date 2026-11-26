import { useState } from 'react'
import { toast } from 'sonner'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { type StatusTone, StatusWord } from '@/components/settings/StatusWord'
import { Button } from '@/components/ui/button'
import { useSupportedAcpAgentCatalog } from '@/hooks/use-resolved-supported-acp-agents'
import {
  installSupportedAgent,
  isInstallable,
  isOnDemandRuntimeAgent
} from '@/lib/agents/agent-setup'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'

export type ProviderAgentId = 'antigravity-acp' | 'claude-acp' | 'codex-acp'

export interface ProviderAgentRuntimeState {
  entry: SupportedAcpAgentEntry | null
  badge: React.ReactNode
  installing: boolean
  install: () => Promise<void>
}

function runtimeStatusBadge(entry: SupportedAcpAgentEntry): {
  label: string
  tone: StatusTone
} {
  if (entry.status === 'ready') {
    if (isOnDemandRuntimeAgent(entry)) {
      return { label: `Ready via ${entry.runtimeLauncher}`, tone: 'muted' }
    }
    return { label: 'Installed', tone: 'success' }
  }
  if (entry.status === 'install-required') {
    return { label: 'Runtime not installed', tone: 'warning' }
  }
  if (entry.status === 'needs-runtime') {
    return {
      label: entry.runtimeLauncher === 'uvx' ? 'Needs uv' : 'Needs Node.js',
      tone: 'warning'
    }
  }
  if (entry.status === 'manual-install') {
    return { label: 'Not installed', tone: 'warning' }
  }
  return { label: 'Unavailable', tone: 'muted' }
}

/**
 * Resolves the Karsa ACP runtime state for an account provider (`antigravity-acp`,
 * `claude-acp`, `codex-acp`) so Accounts and Chat never appear out of sync.
 */
export function useProviderAgentRuntime(agentId: ProviderAgentId): ProviderAgentRuntimeState {
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const { entries, recheck } = useSupportedAcpAgentCatalog(agentConfigs)
  const [installing, setInstalling] = useState(false)

  const entry = entries.find((candidate) => candidate.id === agentId) ?? null

  const install = async (): Promise<void> => {
    if (!entry || !isInstallable(entry) || installing) return
    setInstalling(true)
    try {
      await installSupportedAgent(entry)
      recheck()
      void logFrontendError({
        level: 'info',
        source: 'ProviderAgentRuntime',
        message: `Installed ${entry.id} runtime from Accounts settings`
      })
      toast.success(`${entry.agent.name} installed and ready for chats`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      void logFrontendError({
        level: 'warn',
        source: 'ProviderAgentRuntime',
        message: `Install of ${entry.id} runtime from Accounts settings failed: ${message}`
      })
      toast.error(`Could not install ${entry.agent.name}: ${message}`)
    } finally {
      setInstalling(false)
    }
  }

  let badge: React.ReactNode = null
  if (installing) {
    badge = (
      <StatusWord tone="muted" pending>
        Installing…
      </StatusWord>
    )
  } else if (entry) {
    const spec = runtimeStatusBadge(entry)
    badge = <StatusWord tone={spec.tone}>{spec.label}</StatusWord>
  }

  return { entry, badge, installing, install }
}

interface ProviderAgentRuntimeBannerProps {
  runtime: ProviderAgentRuntimeState
  canManage: boolean
}

/**
 * Surfaces missing agent binary/runtime state directly inside Settings → Accounts
 * with a one-click Install button so signed-in accounts and chat readiness stay unified.
 */
export function ProviderAgentRuntimeBanner({
  runtime,
  canManage
}: ProviderAgentRuntimeBannerProps): React.JSX.Element | null {
  const { entry, installing, install } = runtime
  if (!entry || entry.status === 'ready') return null

  if (entry.status === 'install-required' && isInstallable(entry)) {
    return (
      <SettingsNotice
        tone="warning"
        data-testid={`provider-runtime-banner-${entry.id}`}
        action={
          canManage ? (
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={installing}
              onClick={() => void install()}
            >
              {installing ? 'Installing…' : 'Install'}
            </Button>
          ) : undefined
        }
      >
        <span className="font-medium text-foreground">
          {entry.agent.name} runtime is not installed in Karsa yet.
        </span>{' '}
        Your account login is separate from the agent binary — install it once here so chats can use
        this account immediately.
      </SettingsNotice>
    )
  }

  if (entry.status === 'needs-runtime') {
    const runtimeLabel = entry.runtimeLauncher === 'uvx' ? 'uv' : 'Node.js'
    return (
      <SettingsNotice tone="warning" data-testid={`provider-runtime-banner-${entry.id}`}>
        <span className="font-medium text-foreground">{runtimeLabel} is required</span> to launch{' '}
        {entry.agent.name} in chats. Install {runtimeLabel}, then restart Karsa.
      </SettingsNotice>
    )
  }

  if (entry.status === 'manual-install') {
    return (
      <SettingsNotice tone="warning" data-testid={`provider-runtime-banner-${entry.id}`}>
        <span className="font-medium text-foreground">
          {entry.agent.name} is not installed locally.
        </span>{' '}
        {entry.unavailableReason ??
          `Install ${entry.agent.name} on this computer so chats can use this account.`}
      </SettingsNotice>
    )
  }

  return null
}
