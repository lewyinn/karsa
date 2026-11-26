import { useMemo, useState } from 'react'
import { ArrowLeft, RefreshCw } from '@/components/icons'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { StatusWord } from '@/components/settings/StatusWord'
import { Button } from '@/components/ui/button'
import { useProviderSignIn } from '@/hooks/use-provider-sign-in'
import { useSupportedAcpAgentCatalog } from '@/hooks/use-resolved-supported-acp-agents'
import { agentSetupStatus, featuredAgents, isOnDemandRuntimeAgent } from '@/lib/agents/agent-setup'
import {
  entryServesConfigId,
  pickDefaultSupportedAgent,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import { useAcpStore } from '@/stores/acp-store'
import { AgentSetupRow } from './AgentSetupRow'
import { StepFrame, TOUCH_TARGET_CLASS } from './OnboardingFrame'

export interface AgentsStepProps {
  /** The config id picked on an earlier visit, if any. */
  initialConfigId: string | null
  onBack: () => void
  /** null: "Set up later". */
  onDone: (agent: SupportedAcpAgentEntry | null) => void
}

/** Moves focus between the pickable options with the arrow keys. */
function moveOptionFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const options = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="option"][tabindex="0"]')
  )
  const index = options.indexOf(document.activeElement as HTMLElement)
  if (index === -1) return
  event.preventDefault()
  const next = event.key === 'ArrowDown' ? index + 1 : index - 1
  options[(next + options.length) % options.length]?.focus()
}

function readySummaryTitle(ready: readonly SupportedAcpAgentEntry[]): string {
  if (ready.length === 0) return 'No agents ready yet'
  const onDemand = ready.filter(isOnDemandRuntimeAgent)
  const installedCount = ready.length - onDemand.length
  const launchers = new Set(onDemand.map((entry) => entry.runtimeLauncher).filter(Boolean))
  const launcherLabel = launchers.size === 1 ? [...launchers][0] : 'npx/uvx'

  if (installedCount > 0 && onDemand.length > 0) {
    return `${installedCount} installed locally · ${onDemand.length} ready via ${launcherLabel}`
  }
  if (installedCount > 0) {
    return `${installedCount} installed locally`
  }
  return `${onDemand.length} ready via ${launcherLabel} (none installed locally)`
}

export function AgentsStep({
  initialConfigId,
  onBack,
  onDone
}: AgentsStepProps): React.JSX.Element {
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const { entries, checking, recheck } = useSupportedAcpAgentCatalog(agentConfigs)
  const signIn = useProviderSignIn()
  const [chosenId, setChosenId] = useState<string | null>(initialConfigId)
  const [showAll, setShowAll] = useState(false)

  const { featured, rest } = useMemo(
    () => featuredAgents(entries, agentConfigs),
    [entries, agentConfigs]
  )
  const statusOf = (entry: SupportedAcpAgentEntry) => agentSetupStatus(entry, signIn.of(entry.id))
  const ready = entries.filter((entry) => statusOf(entry).kind === 'ready')
  // Derived every render: a chosen agent that stops being ready falls back to the default.
  const chosen =
    (chosenId ? ready.find((entry) => entryServesConfigId(entry, chosenId)) : undefined) ??
    pickDefaultSupportedAgent(ready)
  const visible = showAll ? [...featured, ...rest] : featured
  const loading = checking && entries.length === 0

  return (
    <StepFrame
      step="agents"
      wide
      title="Check your agents"
      body="Karsa runs the coding agents you already use. Pick the one new chats start with. You can add more later."
      footer={
        <>
          <Button variant="ghost" size="sm" className={TOUCH_TARGET_CLASS} onClick={onBack}>
            <ArrowLeft size={14} className="mr-1.5" />
            Back
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!checking && !chosen && (
              <>
                <span className="text-xs text-muted-foreground">
                  Install or sign in to one agent to continue
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className={TOUCH_TARGET_CLASS}
                  onClick={() => onDone(null)}
                >
                  Set up later
                </Button>
              </>
            )}
            <Button
              size="sm"
              className={TOUCH_TARGET_CLASS}
              disabled={!chosen}
              onClick={() => chosen && onDone(chosen)}
            >
              {chosen ? `Continue with ${chosen.agent.name}` : 'Continue'}
            </Button>
          </div>
        </>
      }
    >
      <SettingsGroup
        title={loading ? 'Looking for agents…' : readySummaryTitle(ready)}
        actions={
          <Button
            size="xs"
            variant="ghost"
            className={TOUCH_TARGET_CLASS}
            disabled={checking}
            onClick={() => {
              recheck()
              void signIn.reload()
            }}
          >
            <RefreshCw size={12} className="mr-1" />
            Check again
          </Button>
        }
        footnote={
          rest.length > 0 ? (
            <button
              type="button"
              className={`underline-offset-2 hover:underline ${TOUCH_TARGET_CLASS}`}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Show fewer agents' : `Show all ${entries.length} agents`}
            </button>
          ) : undefined
        }
      >
        {loading ? (
          <SettingsCard>
            <div className="flex min-h-14 items-center justify-between gap-3 px-3 py-2.5 text-xs text-muted-foreground">
              Looking for agents on this computer
              <StatusWord tone="muted" pending>
                Checking…
              </StatusWord>
            </div>
          </SettingsCard>
        ) : (
          <div
            role="listbox"
            aria-label="Agents"
            className="flex flex-col gap-2"
            onKeyDown={moveOptionFocus}
          >
            {visible.map((entry) => (
              <AgentSetupRow
                key={entry.configId}
                entry={entry}
                status={statusOf(entry)}
                signInProvider={signIn.providerOf(entry.id)}
                chosen={chosen === entry}
                onChoose={() => setChosenId(entry.configId)}
                onSignedIn={signIn.reload}
              />
            ))}
          </div>
        )}
      </SettingsGroup>
    </StepFrame>
  )
}
