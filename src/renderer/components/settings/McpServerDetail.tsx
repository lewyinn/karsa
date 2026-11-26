import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ChevronDown, Edit, ExternalLink, RefreshCw } from '@/components/icons'
import { McpCatalogIcon } from '@/components/settings/McpCatalogIcon'
import { SettingsFilter } from '@/components/settings/SettingsFilter'
import {
  SETTINGS_CARD_CLASS,
  SettingsCard,
  SettingsGroup
} from '@/components/settings/SettingsGroup'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { StatusWord } from '@/components/settings/StatusWord'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { Switch } from '@/components/ui/switch'
import type { McpToolInfo, ProbeStatus } from '@/lib/acp-api'
import { type StoredMcpServer, transportOf } from '@/lib/acp-mcp-persistence'
import { cn } from '@/lib/utils'
import {
  type McpServerStatus,
  mcpServerIsRemote,
  mcpServerTarget,
  mcpToolCount
} from './mcp-server-view'

/** Tools shown before "Show all". */
const FIRST_TOOLS = 5

interface McpServerDetailProps {
  server: StoredMcpServer
  status: McpServerStatus
  probeStatus: ProbeStatus | undefined
  probeError: string | undefined
  probing: boolean
  tools: McpToolInfo[] | undefined
  oauthConnected: boolean
  oauthConnecting: boolean
  onBack: () => void
  onToggle: (enabled: boolean) => void
  onTest: () => void
  onEdit: () => void
  onConnect: () => void
  onDisconnect: () => void
  onLoadTools: () => void
  onRemove: () => void
}

/**
 * One added MCP server on its own page: a header with its state and switch,
 * then Connection (with Test connection and Edit), Tools, and Remove. A
 * problem shows as one notice under the Connection title, with its action.
 */
export function McpServerDetail({
  server,
  status,
  probeStatus,
  probeError,
  probing,
  tools,
  oauthConnected,
  oauthConnecting,
  onBack,
  onToggle,
  onTest,
  onEdit,
  onConnect,
  onDisconnect,
  onLoadTools,
  onRemove
}: McpServerDetailProps): React.JSX.Element {
  const enabled = server.enabled !== false
  const transport = transportOf(server)
  const target = mcpServerTarget(server)
  const remote = mcpServerIsRemote(server)

  // The tool list loads on demand; opening the page is the demand.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per server; onLoadTools is recreated each render
  useEffect(() => {
    if (enabled) onLoadTools()
  }, [server.id, enabled])

  return (
    <div className="flex flex-col gap-8" data-testid="mcp-server-detail">
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            'flex w-fit items-center gap-1.5 rounded-sm text-xs font-medium text-secondary-foreground hover:text-foreground',
            FOCUS_RING_CLASS
          )}
        >
          <ArrowLeft size={14} aria-hidden />
          MCP servers
        </button>
        <div className="flex items-center gap-3">
          <McpCatalogIcon
            name={server.catalog?.name ?? null}
            displayName={server.name}
            hasIcon={server.catalog !== undefined}
            size={40}
          />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-xl font-medium tracking-[-0.01em] text-foreground">
              {server.name}
            </h3>
            <StatusWord tone={status.tone} pending={status.pending}>
              {status.label}
              {enabled && status.tone === 'success' ? ' · offered to new chats' : ''}
            </StatusWord>
          </div>
          <Switch
            checked={enabled}
            aria-label={`${enabled ? 'Disable' : 'Enable'} ${server.name}`}
            onCheckedChange={onToggle}
          />
        </div>
        {server.catalog && (
          <p className="text-xs text-muted-foreground">
            From the catalog · <span className="font-mono">{server.catalog.name}</span>
          </p>
        )}
      </div>

      <SettingsGroup
        title="Connection"
        actions={
          <>
            {probeStatus !== 'disconnected' && (
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={probing || !enabled}
                onClick={onTest}
              >
                <RefreshCw size={12} />
                Test connection
              </Button>
            )}
            <Button type="button" size="xs" variant="secondary" onClick={onEdit}>
              <Edit size={12} />
              Edit
            </Button>
          </>
        }
      >
        {enabled && probeStatus === 'authRequired' && (
          <SettingsNotice
            tone="warning"
            action={
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={oauthConnecting}
                onClick={onConnect}
              >
                <ExternalLink size={12} />
                {oauthConnecting ? 'Connecting…' : 'Connect'}
              </Button>
            }
          >
            This server uses OAuth. Select Connect to sign in in your browser.
          </SettingsNotice>
        )}
        {enabled && probeStatus === 'disconnected' && (
          <SettingsNotice
            tone="danger"
            action={
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={probing}
                onClick={onTest}
              >
                <RefreshCw size={12} />
                Try again
              </Button>
            }
          >
            Karsa could not reach this server. Check the command, URL and environment values, then
            try again.
            {probeError ? (
              <span className="mt-1 block break-words font-mono text-muted-foreground">
                {probeError}
              </span>
            ) : null}
          </SettingsNotice>
        )}
        <SettingsCard>
          <DetailRow label="Transport">
            <span className="font-mono">{transport}</span>
          </DetailRow>
          <DetailRow label={remote ? 'URL' : 'Command'}>
            <span className="break-all font-mono">{target}</span>
          </DetailRow>
          {remote && (
            <DetailRow
              label="Sign-in"
              action={
                oauthConnected ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="h-6 text-secondary-foreground"
                    disabled={oauthConnecting}
                    onClick={onDisconnect}
                  >
                    Disconnect
                  </Button>
                ) : null
              }
            >
              {probeStatus === 'authRequired'
                ? oauthConnected
                  ? 'OAuth · sign-in expired'
                  : 'OAuth · not signed in'
                : oauthConnected
                  ? 'OAuth · signed in'
                  : 'None needed'}
            </DetailRow>
          )}
        </SettingsCard>
      </SettingsGroup>

      <ToolsGroup enabled={enabled} tools={tools} probing={probing} probeStatus={probeStatus} />

      <div className={cn('flex items-center gap-6 px-4 py-3.5', SETTINGS_CARD_CLASS)}>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium leading-4 text-foreground">Remove server</p>
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
            New chats stop offering its tools. You can undo it for a few seconds.
          </p>
        </div>
        <Button
          type="button"
          size="xs"
          variant="secondary"
          className="text-destructive hover:text-destructive"
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    </div>
  )
}

function DetailRow({
  label,
  action,
  children
}: {
  label: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-10 items-center gap-3 px-4 py-2.5">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-xs text-foreground">{children}</span>
      {action}
    </div>
  )
}

function ToolsGroup({
  enabled,
  tools,
  probing,
  probeStatus
}: {
  enabled: boolean
  tools: McpToolInfo[] | undefined
  probing: boolean
  probeStatus: ProbeStatus | undefined
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [showAll, setShowAll] = useState(false)
  const query = filter.trim().toLowerCase()
  const matching = useMemo(
    () =>
      (tools ?? []).filter(
        (tool) =>
          !query ||
          tool.name.toLowerCase().includes(query) ||
          (tool.description ?? '').toLowerCase().includes(query)
      ),
    [tools, query]
  )
  const shown = showAll || query ? matching : matching.slice(0, FIRST_TOOLS)
  const hidden = matching.length - shown.length

  const empty = !enabled
    ? 'Turn the server on to see its tools.'
    : probing
      ? 'Checking…'
      : probeStatus === 'authRequired'
        ? "Sign in to see this server's tools."
        : probeStatus === 'disconnected'
          ? 'Tools show once Karsa can reach the server.'
          : tools && tools.length === 0
            ? 'The server answered but offers no tools.'
            : 'Loading tools…'

  return (
    <SettingsGroup
      title="Tools"
      meta={tools && tools.length > 0 ? String(tools.length) : undefined}
      actions={
        tools && tools.length > FIRST_TOOLS ? (
          <SettingsFilter
            className="w-52"
            label="Filter tools"
            value={filter}
            onValueChange={setFilter}
          />
        ) : undefined
      }
    >
      {tools && tools.length > 0 ? (
        <>
          {matching.length === 0 ? (
            <div className={cn('px-4 py-3 text-xs text-muted-foreground', SETTINGS_CARD_CLASS)}>
              No tools match "{filter.trim()}".
            </div>
          ) : (
            <SettingsCard>
              {shown.map((tool) => (
                <div key={tool.name} className="flex min-w-0 items-baseline gap-3 px-4 py-2.5">
                  <span className="w-44 shrink-0 truncate font-mono text-xs text-foreground">
                    {tool.name}
                  </span>
                  {tool.description ? (
                    <span className="fade-end min-w-0 flex-1 text-xs text-muted-foreground">
                      {tool.description}
                    </span>
                  ) : null}
                </div>
              ))}
            </SettingsCard>
          )}
          {hidden > 0 && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="self-start text-secondary-foreground"
              onClick={() => setShowAll(true)}
            >
              Show all {mcpToolCount(tools)?.replace(/ tools?$/, '')}
              <ChevronDown size={12} />
            </Button>
          )}
        </>
      ) : (
        <div className={cn('px-4 py-3 text-xs text-muted-foreground', SETTINGS_CARD_CLASS)}>
          {empty}
        </div>
      )}
    </SettingsGroup>
  )
}
