import type { DiscoveredGitRepo } from '@shared/types/ipc.types'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ExternalLink,
  Layers,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  Wrench
} from '@/components/icons'
import { SidePanelHeader } from '@/components/shell/SidePanelHeader'
import { Button } from '@/components/ui/button'
import { PANEL_FIELD_CLASS, QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { openerApi } from '@/lib/api'
import {
  detectTranscriptError,
  extractDetectedUrls,
  type StackServiceConfig
} from '@/lib/stack-discovery'
import { cn } from '@/lib/utils'
import { mergeProjectServices, useRunStackStore } from '@/stores/run-stack-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { Terminal } from '@/types/project'

interface RunStackPanelProps {
  projectId: string
  projectRoot: string
  repos: readonly DiscoveredGitRepo[]
}

const EMPTY_SERVICES: StackServiceConfig[] = []

function joinCwd(root: string, sub: string): string {
  const trimmed = sub.trim()
  if (!trimmed || trimmed === '.') return root
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) return trimmed
  const cleanRoot = root.replace(/[\\/]+$/, '')
  const sep = cleanRoot.includes('\\') && !cleanRoot.includes('/') ? '\\' : '/'
  return `${cleanRoot}${sep}${trimmed.replace(/^[\\/]+/, '')}`
}

interface ServiceCardProps {
  projectId: string
  service: StackServiceConfig
  terminal: Terminal | undefined
  urls: string[]
  hasError: boolean
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onFocusTerminal: () => void
  onFixInChat: () => void
  onUpdateCommand: (command: string) => void
  onRemoveCustom?: () => void
}

function ServiceCard({
  service,
  terminal,
  urls,
  hasError,
  onStart,
  onStop,
  onRestart,
  onFocusTerminal,
  onFixInChat,
  onUpdateCommand,
  onRemoveCustom
}: ServiceCardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draftCommand, setDraftCommand] = useState(service.command)

  const isRunning = Boolean(
    terminal?.ptyId && (terminal.lastExitCode === null || terminal.lastExitCode === undefined)
  )
  const isExitedWithError =
    terminal !== undefined &&
    terminal.lastExitCode !== null &&
    terminal.lastExitCode !== undefined &&
    terminal.lastExitCode !== 0
  const showError = hasError || isExitedWithError

  const saveCommand = () => {
    const trimmed = draftCommand.trim()
    if (trimmed && trimmed !== service.command) {
      onUpdateCommand(trimmed)
    } else {
      setDraftCommand(service.command)
    }
    setEditing(false)
  }

  return (
    <div
      data-testid={`stack-service-${service.name}`}
      className={cn(
        'rounded-lg border bg-card p-2.5 transition-colors',
        showError ? 'border-destructive/50' : 'border-border'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-label={isRunning ? 'Running' : showError ? 'Error' : 'Stopped'}
            className={cn(
              'mt-0.5 size-2 shrink-0 rounded-full',
              showError
                ? 'bg-destructive'
                : isRunning
                  ? 'bg-diff-added animate-pulse'
                  : 'bg-muted-foreground/35'
            )}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-xs font-medium text-foreground">{service.name}</span>
              <span className="rounded bg-muted px-1.5 py-px font-mono text-3xs text-secondary-foreground">
                {service.runtimeLabel}
              </span>
            </div>
            {service.relativePath !== '.' && (
              <div className="truncate font-mono text-3xs text-muted-foreground">
                {service.relativePath}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {isRunning ? (
            <>
              <button
                type="button"
                aria-label={`Restart ${service.name}`}
                title={`Restart ${service.name}`}
                onClick={onRestart}
                className={cn(QUIET_ICON_BUTTON_CLASS, 'size-6')}
              >
                <RotateCw size={12} />
              </button>
              <button
                type="button"
                aria-label={`Stop ${service.name}`}
                title={`Stop ${service.name}`}
                onClick={onStop}
                className={cn(
                  QUIET_ICON_BUTTON_CLASS,
                  'size-6 text-destructive hover:text-destructive'
                )}
              >
                <Square size={11} />
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label={`Start ${service.name}`}
              title={`Start ${service.name}`}
              onClick={onStart}
              className={cn(
                QUIET_ICON_BUTTON_CLASS,
                'size-6 text-diff-added-foreground hover:text-diff-added-foreground'
              )}
            >
              <Play size={12} />
            </button>
          )}
          {terminal && (
            <button
              type="button"
              aria-label={`Open terminal for ${service.name}`}
              title="Focus service terminal"
              onClick={onFocusTerminal}
              className={cn(QUIET_ICON_BUTTON_CLASS, 'size-6')}
            >
              <TerminalIcon size={12} />
            </button>
          )}
          {onRemoveCustom && (
            <button
              type="button"
              aria-label={`Remove ${service.name}`}
              title="Remove custom service"
              onClick={onRemoveCustom}
              className={cn(QUIET_ICON_BUTTON_CLASS, 'size-6 hover:text-destructive')}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="mt-2">
        {editing ? (
          <input
            type="text"
            aria-label={`Command for ${service.name}`}
            className={cn(PANEL_FIELD_CLASS, 'h-7 w-full px-2 font-mono text-2xs')}
            value={draftCommand}
            onChange={(e) => setDraftCommand(e.target.value)}
            onBlur={saveCommand}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveCommand()
              if (e.key === 'Escape') {
                setDraftCommand(service.command)
                setEditing(false)
              }
            }}
            autoFocus
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraftCommand(service.command)
              setEditing(true)
            }}
            title="Click to edit start command"
            className="w-full truncate rounded bg-muted/50 px-2 py-1 text-left font-mono text-3xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            $ {service.command}
          </button>
        )}
      </div>

      {(urls.length > 0 || terminal) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex flex-wrap items-center gap-1">
            {urls.slice(0, 2).map((url) => (
              <button
                key={url}
                type="button"
                onClick={() => void openerApi.openUrlWithSystemBrowser(url)}
                className="inline-flex items-center gap-1 rounded bg-diff-added/15 px-1.5 py-0.5 font-mono text-3xs text-diff-added-foreground transition-opacity hover:opacity-80"
                title={`Open ${url}`}
              >
                {url.replace(/^https?:\/\//, '')}
                <ExternalLink size={10} />
              </button>
            ))}
          </div>

          {terminal && (
            <Button
              type="button"
              size="xs"
              variant={showError ? 'destructive' : 'outline'}
              className="h-6 gap-1 px-2 text-3xs"
              onClick={onFixInChat}
              title="Send recent terminal logs to AI Chat to diagnose and fix"
            >
              {showError ? <AlertTriangle size={11} /> : <Wrench size={11} />}
              {showError ? 'Fix in Chat' : 'Debug in Chat'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function RunStackPanel({
  projectId,
  projectRoot,
  repos
}: RunStackPanelProps): React.JSX.Element {
  const discovered = useRunStackStore(
    (state) => state.discoveredByProject[projectId] ?? EMPTY_SERVICES
  )
  const persisted = useRunStackStore((state) => state.persistedByProject[projectId])
  const loading = useRunStackStore((state) => state.loadingByProject[projectId] ?? false)
  const terminalByServiceKey = useRunStackStore((state) => state.terminalByServiceKey)
  const terminals = useTerminalStore((state) => state.terminals)

  const services = useMemo(
    () => mergeProjectServices(discovered, persisted),
    [discovered, persisted]
  )

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSubdir, setNewSubdir] = useState('')
  const [newCommand, setNewCommand] = useState('')
  const [, setPollTick] = useState(0)

  useEffect(() => {
    void useRunStackStore.getState().discover(projectId, projectRoot, repos)
  }, [projectId, projectRoot, repos])

  const terminalByServiceId = useMemo(() => {
    const map = new Map<string, Terminal>()
    for (const service of services) {
      const termId = terminalByServiceKey[`${projectId}::${service.id}`]
      if (!termId) continue
      const term = terminals.find((t) => t.id === termId)
      if (term) map.set(service.id, term)
    }
    return map
  }, [services, terminalByServiceKey, projectId, terminals])

  const hasAnyAttachedTerminal = terminalByServiceId.size > 0
  useEffect(() => {
    if (!hasAnyAttachedTerminal) return
    const timer = setInterval(() => setPollTick((tick) => tick + 1), 1500)
    return () => clearInterval(timer)
  }, [hasAnyAttachedTerminal])

  const runningCount = useMemo(() => {
    let count = 0
    for (const term of terminalByServiceId.values()) {
      if (term.ptyId && (term.lastExitCode === null || term.lastExitCode === undefined)) count += 1
    }
    return count
  }, [terminalByServiceId])

  const handleAddService = (event: React.FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    const command = newCommand.trim()
    if (!name || !command) return
    const subdir = newSubdir.trim() || '.'
    useRunStackStore.getState().addCustomService(projectId, {
      name,
      cwd: joinCwd(projectRoot, subdir),
      relativePath: subdir,
      command,
      runtimeLabel: 'Custom'
    })
    setNewName('')
    setNewSubdir('')
    setNewCommand('')
    setAdding(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidePanelHeader title="Run Stack">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Add custom service"
            title="Add custom service"
            onClick={() => setAdding((open) => !open)}
            className={cn(QUIET_ICON_BUTTON_CLASS, 'size-7')}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label="Rescan services"
            title="Rescan services"
            onClick={() => void useRunStackStore.getState().discover(projectId, projectRoot, repos)}
            className={cn(QUIET_ICON_BUTTON_CLASS, 'size-7')}
          >
            <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
          </button>
        </div>
      </SidePanelHeader>

      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="default"
            disabled={services.length === 0}
            onClick={() => void useRunStackStore.getState().startAll(projectId, services)}
            className="gap-1"
          >
            <Play size={11} />
            Run all
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={runningCount === 0}
            onClick={() => void useRunStackStore.getState().stopAll(projectId, services)}
            className="gap-1"
          >
            <Square size={10} />
            Stop all
          </Button>
        </div>
        <span className="font-mono text-3xs text-muted-foreground">
          {runningCount}/{services.length} live
        </span>
      </div>

      {adding && (
        <form
          onSubmit={handleAddService}
          className="space-y-1.5 border-b border-border/60 bg-muted/20 p-3"
        >
          <input
            type="text"
            placeholder="Service name (e.g. worker)"
            className={cn(PANEL_FIELD_CLASS, 'h-7 w-full px-2 text-xs')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <input
            type="text"
            placeholder="Folder relative to project (e.g. backend or .)"
            className={cn(PANEL_FIELD_CLASS, 'h-7 w-full px-2 font-mono text-2xs')}
            value={newSubdir}
            onChange={(e) => setNewSubdir(e.target.value)}
          />
          <input
            type="text"
            placeholder="Command (e.g. bun run dev)"
            className={cn(PANEL_FIELD_CLASS, 'h-7 w-full px-2 font-mono text-2xs')}
            value={newCommand}
            onChange={(e) => setNewCommand(e.target.value)}
            required
          />
          <div className="flex justify-end gap-1.5 pt-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" variant="default">
              Add service
            </Button>
          </div>
        </form>
      )}

      <div className="scroller-thin min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {loading && services.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Spinner size={14} decorative />
            Scanning services…
          </div>
        ) : services.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Layers size={22} className="text-muted-foreground/50" />
            <p className="text-xs font-medium text-foreground">No dev services detected</p>
            <p className="max-w-[220px] text-2xs text-muted-foreground">
              Add a custom service command for your frontend, backend, or worker.
            </p>
            <Button type="button" size="xs" variant="outline" onClick={() => setAdding(true)}>
              <Plus size={12} />
              Add service
            </Button>
          </div>
        ) : (
          services.map((service) => {
            const term = terminalByServiceId.get(service.id)
            const transcript = term?.ptyId
              ? useTerminalStore.getState().peekTranscript(term.ptyId)
              : ''
            const urls = transcript ? extractDetectedUrls(transcript) : []
            const hasError = detectTranscriptError(transcript, term?.lastExitCode ?? null)

            return (
              <ServiceCard
                key={service.id}
                projectId={projectId}
                service={service}
                terminal={term}
                urls={urls}
                hasError={hasError}
                onStart={() => void useRunStackStore.getState().startService(projectId, service)}
                onStop={() => void useRunStackStore.getState().stopService(projectId, service.id)}
                onRestart={() =>
                  void useRunStackStore.getState().restartService(projectId, service)
                }
                onFocusTerminal={() =>
                  useRunStackStore.getState().focusServiceTerminal(projectId, service.id)
                }
                onFixInChat={() =>
                  void useRunStackStore.getState().fixServiceInChat(projectId, service)
                }
                onUpdateCommand={(command) =>
                  useRunStackStore.getState().setCommandOverride(projectId, service.id, command)
                }
                onRemoveCustom={
                  service.custom
                    ? () => useRunStackStore.getState().removeCustomService(projectId, service.id)
                    : undefined
                }
              />
            )
          })
        )}
      </div>
    </div>
  )
}
