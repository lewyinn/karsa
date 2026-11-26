import type { AntigravityAccountView } from '@shared/types/antigravity-accounts.types'
import type { ClaudeAccountView } from '@shared/types/claude-accounts.types'
import type { CodexAccountView } from '@shared/types/codex-accounts.types'
import { useState } from 'react'
import { toast } from 'sonner'
import { AgentGlyph } from '@/components/chat/AgentGlyph'
import { Check, ExternalLink } from '@/components/icons'
import { AntigravitySignInDialog } from '@/components/settings/provider/AntigravitySignInDialog'
import { CodexSignInDialog } from '@/components/settings/provider/CodexSignInDialog'
import { LinkSignInDialog } from '@/components/settings/provider/LinkSignInDialog'
import { type StatusTone, StatusWord } from '@/components/settings/StatusWord'
import { Button } from '@/components/ui/button'
import type { SignInProvider } from '@/hooks/use-provider-sign-in'
import {
  type AgentSetupKind,
  type AgentSetupStatus,
  installSupportedAgent,
  isInstallable,
  isOnDemandRuntimeAgent,
  RUNTIME_HELP_URLS,
  saveSupportedAgentConfig
} from '@/lib/agents/agent-setup'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { openerApi } from '@/lib/api'
import { claudeAccountsApi, isClaudeLoginCancelled } from '@/lib/claude-accounts-api'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { TOUCH_TARGET_CLASS } from './OnboardingFrame'

interface StatusWordSpec {
  label: string
  tone: StatusTone
  pending?: boolean
}

/** The word each setup status reads as. Exhaustive: a new status fails the build here. */
const ONBOARDING_AGENT_STATUS: {
  [K in AgentSetupKind]: (
    status: Extract<AgentSetupStatus, { kind: K }>,
    entry: SupportedAcpAgentEntry
  ) => StatusWordSpec
} = {
  ready: (_status, entry) =>
    isOnDemandRuntimeAgent(entry)
      ? { label: `Ready via ${entry.runtimeLauncher}`, tone: 'muted' }
      : { label: 'Installed', tone: 'success' },
  'checking-sign-in': () => ({ label: 'Checking…', tone: 'muted', pending: true }),
  'needs-sign-in': () => ({ label: 'Needs sign-in', tone: 'warning' }),
  installable: () => ({ label: 'Not installed', tone: 'muted' }),
  'manual-install': () => ({ label: 'Not installed', tone: 'muted' }),
  'needs-runtime': (s) => ({
    label: s.runtime === 'uvx' ? 'Needs uv' : 'Needs Node.js',
    tone: 'warning'
  }),
  unavailable: () => ({ label: 'Not available here', tone: 'muted' })
}

function statusWord(status: AgentSetupStatus, entry: SupportedAcpAgentEntry): StatusWordSpec {
  return (
    ONBOARDING_AGENT_STATUS[status.kind] as (
      s: AgentSetupStatus,
      e: SupportedAcpAgentEntry
    ) => StatusWordSpec
  )(status, entry)
}

function runtimeName(runtime: 'npx' | 'uvx'): string {
  return runtime === 'uvx' ? 'uv' : 'Node.js'
}

/**
 * The row's one line of detail. The entry's own reason text is shown only for
 * Claude's manual install: the host stamps Claude's reason on other agents.
 */
function detailFor(entry: SupportedAcpAgentEntry, status: AgentSetupStatus): string {
  switch (status.kind) {
    case 'ready':
      if (isOnDemandRuntimeAgent(entry)) {
        return `Runs on demand via ${entry.runtimeLauncher} · Not installed locally`
      }
      return entry.installedVersion
        ? `Installed locally · v${entry.installedVersion}`
        : 'Installed locally'
    case 'checking-sign-in':
      return 'Checking sign-in'
    case 'needs-sign-in':
      return 'Installed · Not signed in'
    case 'installable':
      return entry.install?.kind === 'managed-npm'
        ? 'Karsa installs it with npm'
        : 'Karsa downloads and installs it'
    case 'manual-install':
      return 'Install it yourself, then check again'
    case 'needs-runtime':
      return `Install ${runtimeName(status.runtime)}, then restart Karsa`
    case 'unavailable':
      return 'Not offered for this system'
  }
}

function manualInstallGuide(entry: SupportedAcpAgentEntry): string {
  if (entry.id === 'claude-acp' && entry.unavailableReason) return entry.unavailableReason
  const cmd = entry.manualInstall?.cmd
  return cmd
    ? `Install ${entry.agent.name} from its vendor, then make sure \`${cmd}\` is on your PATH.`
    : `Install ${entry.agent.name} from its vendor, then check again.`
}

function log(level: 'info' | 'warn', message: string): void {
  void logFrontendError({ level, source: 'onboarding', message })
}

export interface AgentSetupRowProps {
  entry: SupportedAcpAgentEntry
  status: AgentSetupStatus
  signInProvider: SignInProvider | null
  chosen: boolean
  onChoose: () => void
  /** A sign-in finished: read the account lists again. */
  onSignedIn: () => Promise<void>
}

/**
 * One pick-one option card (docs/design/forms.md exception): only a ready
 * agent can be chosen, and every other status carries the one action that
 * moves it toward ready.
 */
export function AgentSetupRow({
  entry,
  status,
  signInProvider,
  chosen,
  onChoose,
  onSignedIn
}: AgentSetupRowProps): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  const [linkAccount, setLinkAccount] = useState<ClaudeAccountView | null>(null)
  const [codexAccount, setCodexAccount] = useState<CodexAccountView | null>(null)
  const [antigravityAccount, setAntigravityAccount] = useState<AntigravityAccountView | null>(null)
  const selectable = status.kind === 'ready'
  const word = busy
    ? { label: busy, tone: 'muted' as const, pending: true }
    : statusWord(status, entry)

  const install = async (): Promise<void> => {
    if (!isInstallable(entry)) return
    setBusy('Installing…')
    try {
      await installSupportedAgent(entry)
      log('info', `Installed ${entry.id}`)
    } catch (err) {
      log('warn', `Install of ${entry.id} failed`)
      toast.error(`Could not install ${entry.agent.name}: ${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const signedIn = async (): Promise<void> => {
    log('info', `Signed in to ${entry.id}`)
    await onSignedIn()
  }

  const signIn = async (): Promise<void> => {
    if (!signInProvider) return
    if (signInProvider.kind === 'codex' || signInProvider.kind === 'antigravity') {
      try {
        // Codex and Antigravity sign in through their saved launch config.
        await saveSupportedAgentConfig(entry)
        if (signInProvider.kind === 'codex') setCodexAccount(signInProvider.account)
        else setAntigravityAccount(signInProvider.account)
      } catch (err) {
        log('warn', `Saving ${entry.id} before sign-in failed`)
        toast.error(`Could not start sign-in: ${String(err)}`)
      }
      return
    }
    if (claudeAccountsApi.signInFlow() === 'link') {
      setLinkAccount(signInProvider.account)
      return
    }
    setBusy('Waiting for browser…')
    try {
      await claudeAccountsApi.login(signInProvider.account.id)
      await signedIn()
    } catch (err) {
      if (!isClaudeLoginCancelled(err)) {
        log('warn', `Sign-in to ${entry.id} failed`)
        toast.error(`Sign-in did not finish: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      setBusy(null)
    }
  }

  const actionClass = cn('shrink-0', TOUCH_TARGET_CLASS)
  const stop = (run: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation()
    run()
  }

  let action: React.ReactNode = null
  if (!busy && status.kind === 'installable') {
    action = (
      <Button size="xs" variant="secondary" className={actionClass} onClick={stop(install)}>
        Install
      </Button>
    )
  } else if (!busy && status.kind === 'needs-sign-in' && signInProvider) {
    action = (
      <Button size="xs" variant="secondary" className={actionClass} onClick={stop(signIn)}>
        Sign in
      </Button>
    )
  } else if (status.kind === 'needs-runtime') {
    action = (
      <Button
        size="xs"
        variant="ghost"
        className={actionClass}
        onClick={stop(
          () => void openerApi.openUrlWithSystemBrowser(RUNTIME_HELP_URLS[status.runtime])
        )}
      >
        Get {runtimeName(status.runtime)}
        <ExternalLink size={12} className="ml-1" />
      </Button>
    )
  } else if (status.kind === 'manual-install') {
    action = (
      <Button
        size="xs"
        variant="ghost"
        className={actionClass}
        aria-expanded={showGuide}
        onClick={stop(() => setShowGuide((v) => !v))}
      >
        How to install
      </Button>
    )
  }

  return (
    <>
      <div
        role="option"
        aria-selected={chosen}
        tabIndex={selectable ? 0 : -1}
        data-agent-id={entry.id}
        onClick={() => selectable && onChoose()}
        onKeyDown={(event) => {
          if (!selectable || event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onChoose()
          }
        }}
        className={cn(
          'overflow-hidden rounded-lg border border-border bg-card transition-colors duration-150 ease-out focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring',
          selectable && 'cursor-pointer hover:bg-foreground/[0.03]',
          chosen && 'bg-foreground/[0.03] ring-1 ring-foreground/[0.12]'
        )}
      >
        <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
          <div className="flex min-w-48 flex-1 items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <AgentGlyph templateId={entry.agent.id} icon={entry.config?.icon} size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium leading-4 text-foreground">
                {entry.agent.name}
              </div>
              <div className="truncate text-xs leading-4 text-muted-foreground">
                {detailFor(entry, status)}
              </div>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <StatusWord tone={word.tone} pending={word.pending}>
              {word.label}
            </StatusWord>
            {action}
            <span className="flex size-4 shrink-0 items-center justify-center">
              {chosen && <Check size={14} className="text-foreground" aria-label="Default" />}
            </span>
          </div>
        </div>
        {showGuide && status.kind === 'manual-install' && (
          <p className="border-t border-border/60 px-3 py-3 pl-14 text-xs text-muted-foreground">
            {manualInstallGuide(entry)}
          </p>
        )}
      </div>
      <LinkSignInDialog
        account={linkAccount}
        onClose={() => setLinkAccount(null)}
        onSignedIn={() => {
          setLinkAccount(null)
          void signedIn()
        }}
      />
      <CodexSignInDialog
        account={codexAccount}
        onClose={() => setCodexAccount(null)}
        onSignedIn={async () => {
          setCodexAccount(null)
          await signedIn()
        }}
      />
      <AntigravitySignInDialog
        account={antigravityAccount}
        onClose={() => setAntigravityAccount(null)}
        onSignedIn={async () => {
          setAntigravityAccount(null)
          await signedIn()
        }}
      />
    </>
  )
}
