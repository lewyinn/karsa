import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { acpApi } from '@/lib/acp-api'
import {
  installedBinaryConfig,
  isCustomAgentEntry,
  PREFERRED_DEFAULT_ACP_AGENT_IDS,
  type SupportedAcpAgentEntry,
  type SupportedAcpAgentInstall,
  type SupportedAcpAgentManagedInstall
} from '@/lib/agents/supported-acp-agents'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Sign-in of the agent's default account, for the agents whose login is
 * readable without spawning them (Claude, Codex). Other agents report none.
 */
export type AgentSignIn = 'checking' | 'ready' | 'signed-out' | 'unconfirmed'

/** What an agent still needs before a chat can start on it. Only `ready` can be picked. */
export type AgentSetupStatus =
  | { kind: 'ready' }
  | { kind: 'checking-sign-in' }
  | { kind: 'needs-sign-in' }
  /** The host can install it: the Install action works. */
  | { kind: 'installable' }
  /** The user installs it from the vendor. */
  | { kind: 'manual-install' }
  | { kind: 'needs-runtime'; runtime: 'npx' | 'uvx' }
  | { kind: 'unavailable' }

export type AgentSetupKind = AgentSetupStatus['kind']

/**
 * The host status plus the sign-in read. `unconfirmed` counts as ready: the
 * host could not read the login, and the launcher reports a real auth
 * failure at first send.
 */
export function agentSetupStatus(
  entry: SupportedAcpAgentEntry,
  signIn: AgentSignIn | null
): AgentSetupStatus {
  switch (entry.status) {
    case 'ready':
      if (signIn === 'signed-out') return { kind: 'needs-sign-in' }
      if (signIn === 'checking') return { kind: 'checking-sign-in' }
      return { kind: 'ready' }
    case 'install-required':
      return isInstallable(entry) ? { kind: 'installable' } : { kind: 'manual-install' }
    case 'manual-install':
      return { kind: 'manual-install' }
    case 'needs-runtime':
      // A managed npm agent such as Claude reports no launcher and needs Node.js.
      return { kind: 'needs-runtime', runtime: entry.runtimeLauncher ?? 'npx' }
    case 'unavailable':
      return { kind: 'unavailable' }
  }
}

/**
 * The short list a first-time picker shows, and the rest behind "Show all":
 * the preferred agents in their order, then any other agent that is ready on
 * a config the user owns (saved, host installed or custom).
 */
export function featuredAgents(
  entries: readonly SupportedAcpAgentEntry[],
  savedConfigs: readonly StoredAgentConfig[]
): { featured: SupportedAcpAgentEntry[]; rest: SupportedAcpAgentEntry[] } {
  const saved = new Set(savedConfigs.map((config) => config.id))
  const owned = (entry: SupportedAcpAgentEntry): boolean =>
    entry.status === 'ready' &&
    (isCustomAgentEntry(entry) ||
      entry.installedVersion !== undefined ||
      (entry.config !== null && saved.has(entry.config.id)))
  const preferred = PREFERRED_DEFAULT_ACP_AGENT_IDS.flatMap((id) =>
    entries.filter((entry) => entry.id === id)
  )
  const featured = [...preferred, ...entries.filter((e) => !preferred.includes(e) && owned(e))]
  return { featured, rest: entries.filter((entry) => !featured.includes(entry)) }
}

/** Where to get the runtime a `needs-runtime` agent is missing. */
export const RUNTIME_HELP_URLS = {
  npx: 'https://nodejs.org/en/download',
  uvx: 'https://docs.astral.sh/uv/getting-started/installation/'
} as const satisfies Record<'npx' | 'uvx', string>

/** An entry the host can install: it carries an install spec. */
export type InstallableAgentEntry = SupportedAcpAgentEntry & {
  install: SupportedAcpAgentInstall | SupportedAcpAgentManagedInstall
}

export function isInstallable(entry: SupportedAcpAgentEntry): entry is InstallableAgentEntry {
  return entry.install !== null
}

/**
 * True when a ready agent runs on demand via a package runner (`npx` / `uvx`)
 * rather than from a locally installed binary or package.
 */
export function isOnDemandRuntimeAgent(entry: SupportedAcpAgentEntry): boolean {
  return !entry.installedVersion && entry.runtimeLauncher !== null
}

const runningInstalls = new Map<string, Promise<StoredAgentConfig>>()

/**
 * Host-owned verified install (CAP-6 / Story 9: the request is the agent id
 * only), then the launch config from the outcome, saved to the ACP store.
 * Resolves the saved config; rejects with the host's error and saves nothing.
 * A second call for the same agent while one runs joins it, so two surfaces
 * never start two host installs. Selection, toasts and fallbacks stay with
 * the caller.
 */
export function installSupportedAgent(entry: InstallableAgentEntry): Promise<StoredAgentConfig> {
  const agentId = entry.agent.id
  const running = runningInstalls.get(agentId)
  if (running) return running
  const run = hostInstall(entry).finally(() => runningInstalls.delete(agentId))
  runningInstalls.set(agentId, run)
  return run
}

async function hostInstall(entry: InstallableAgentEntry): Promise<StoredAgentConfig> {
  try {
    const installed = await acpApi.installAcpAgent(entry.agent.id)
    const config = installedBinaryConfig(
      entry.agent,
      installed,
      entry.install.kind === 'archive' ? { env: entry.install.env } : {}
    )
    await useAcpStore.getState().saveAgentConfig(config)
    return config
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: 'agents.install',
      message: `Install of ${entry.agent.id} failed: ${String(err)}`
    })
    throw err
  }
}

/**
 * Saves a ready entry's launch config when it is only catalog-derived and
 * returns the config id a chat starts on. The web client ignores unsaved
 * catalog defaults (#840, #907), so an explicit pick is saved first. Saving
 * an already-saved config is skipped.
 */
export async function saveSupportedAgentConfig(entry: SupportedAcpAgentEntry): Promise<string> {
  const config = entry.config
  if (!config) return entry.configId
  const store = useAcpStore.getState()
  if (!store.agentConfigs.some((saved) => saved.id === config.id)) {
    await store.saveAgentConfig(config)
  }
  return config.id
}
