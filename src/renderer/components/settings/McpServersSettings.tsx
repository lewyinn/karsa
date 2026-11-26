import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Server } from '@/components/icons'
import { McpServerCard } from '@/components/settings/McpServerCard'
import { McpServerDetail } from '@/components/settings/McpServerDetail'
import { useMcpServerDialog } from '@/components/settings/McpServerDialog'
import { SETTINGS_CARD_CLASS, SettingsGroup } from '@/components/settings/SettingsGroup'
import { showUndoToast } from '@/components/settings/undo-toast'
import { Button } from '@/components/ui/button'
import { isMcpServerAutoProbed } from '@/hooks/use-acp-mcp'
import { MCP_UNSAFE_URL, McpOAuthError } from '@/lib/acp-api'
import type { StoredMcpServer } from '@/lib/acp-mcp-persistence'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { mcpServerIsRemote, mcpServerStatus, mcpToolCount } from './mcp-server-view'

export function oauthFailureMessage(error: unknown): string {
  if (error instanceof McpOAuthError) {
    switch (error.code) {
      case MCP_UNSAFE_URL:
        return "This server's sign-in link isn't a secure https link, so Karsa didn't open it."
      case 'OAUTH_DISCOVERY_FAILED':
        return 'Could not discover OAuth settings for this MCP server. Check the server URL and try again.'
      case 'OAUTH_REGISTRATION_FAILED':
        return 'This MCP server rejected OAuth client registration or does not support dynamic client registration.'
      case 'OAUTH_DENIED':
        return 'Sign-in was cancelled or denied by the authorization server.'
      case 'OAUTH_EXCHANGE_FAILED':
        return 'Authorization completed, but exchanging the token failed. Try connecting again.'
      case 'OAUTH_TIMEOUT':
        return 'Sign-in timed out before authorization completed. Try connecting again.'
      case 'UNAUTHORIZED_SERVER_URL':
        return 'This MCP server is not enabled in the host server list. Save or enable it, then try again.'
    }
  }
  return 'OAuth flow failed. Check your browser for the authorization page.'
}

interface McpServersSettingsProps {
  /** The server whose detail page is open, or null for the grid. Uncontrolled when absent. */
  detailId?: string | null
  onDetailChange?: (id: string | null) => void
}

/**
 * The servers you added: a grid of cards (two per row), or one server's
 * detail page. Each enabled server is checked once when Settings opens;
 * Test connection on the detail page checks it again.
 */
export function McpServersSettings({
  detailId: detailIdProp,
  onDetailChange: onDetailChangeProp
}: McpServersSettingsProps): React.JSX.Element {
  const [ownDetailId, setOwnDetailId] = useState<string | null>(null)
  const detailId = detailIdProp === undefined ? ownDetailId : detailIdProp
  const onDetailChange = onDetailChangeProp ?? setOwnDetailId
  const mcpDialog = useMcpServerDialog()
  const servers = useAcpStore((state) => state.mcpServers)
  const saveMcpServer = useAcpStore((state) => state.saveMcpServer)
  const setMcpServerEnabled = useAcpStore((state) => state.setMcpServerEnabled)
  const deleteMcpServer = useAcpStore((state) => state.deleteMcpServer)
  const probeMcpServer = useAcpStore((state) => state.probeMcpServer)
  const loadMcpTools = useAcpStore((state) => state.loadMcpTools)
  const mcpProbeStatus = useAcpStore((state) => state.mcpProbeStatus)
  const mcpProbeError = useAcpStore((state) => state.mcpProbeError)
  const mcpTools = useAcpStore((state) => state.mcpTools)
  const mcpProbing = useAcpStore((state) => state.mcpProbing)
  const mcpOAuthConnecting = useAcpStore((state) => state.mcpOAuthConnecting)
  const mcpOAuthConnected = useAcpStore((state) => state.mcpOAuthConnected)
  const connectMcpOAuth = useAcpStore((state) => state.connectMcpOAuth)
  const disconnectMcpOAuth = useAcpStore((state) => state.disconnectMcpOAuth)
  const checkMcpOAuthStatus = useAcpStore((state) => state.checkMcpOAuthStatus)
  // OAuth host calls name the active project (the web host authorizes the URL
  // against that project's MCP list).
  const activeProjectId = useProjectStore((state) => state.activeProjectId)

  // On Settings mount, probe each configured server once (on-demand) — but
  // skip ids the boot auto-probe pass (`useAcpMcp`) already covered this app
  // run, so opening Settings right after launch does not re-spawn every
  // stdio server. Errors are surfaced in the status — never crashed. Re-runs
  // when the registry list changes shape (add/delete) but not on every
  // toggle (toggle doesn't change reachability); Test connection remains the
  // explicit refresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: shape-only dep — re-probe only when the id set changes shape, not on every toggle; `probeMcpServer` is a stable store action reference.
  useEffect(() => {
    for (const server of servers) {
      if (server.enabled === false) continue
      if (isMcpServerAutoProbed(server.id)) continue
      void probeMcpServer(server.id)
    }
  }, [servers.map((s) => s.id).join('|')])

  // Check OAuth token status for HTTP/SSE servers on mount. If a token
  // exists, the probe will use it automatically and show "connected".
  // biome-ignore lint/correctness/useExhaustiveDependencies: shape-only dep
  useEffect(() => {
    for (const server of servers) {
      if (mcpServerIsRemote(server)) void checkMcpOAuthStatus(activeProjectId, server.id)
    }
  }, [servers.map((s) => s.id).join('|'), activeProjectId])

  // A server removed elsewhere (or by Remove) closes its page.
  useEffect(() => {
    if (detailId !== null && !servers.some((server) => server.id === detailId)) {
      onDetailChange(null)
    }
  }, [detailId, servers, onDetailChange])

  const deleteServer = (server: StoredMcpServer): void => {
    void deleteMcpServer(server.id)
      .then(() => {
        void logFrontendError({
          level: 'info',
          source: 'settings.McpServersSettings',
          message: 'MCP server deleted; undo offered'
        })
        showUndoToast(`Deleted ${server.name}`, () => {
          void saveMcpServer(server)
            .then(() =>
              logFrontendError({
                level: 'info',
                source: 'settings.McpServersSettings',
                message: 'MCP server restored by undo'
              })
            )
            .catch(() => toast.error('Could not restore the MCP server. Add it again from JSON.'))
        })
      })
      .catch(() => {
        toast.error('Could not delete the MCP server. Your previous settings were restored.')
      })
  }

  const toggle = (server: StoredMcpServer, next: boolean): void => {
    void setMcpServerEnabled(server.id, next).catch(() => {
      toast.error('Could not update the MCP server. Your previous setting was restored.')
    })
  }

  const connect = (server: StoredMcpServer): void => {
    void connectMcpOAuth(activeProjectId, server.id)
      .then((connected) => {
        if (connected) toast.success(`Connected to ${server.name}`)
      })
      .catch((error: unknown) => toast.error(oauthFailureMessage(error)))
  }

  const disconnect = (server: StoredMcpServer): void => {
    void disconnectMcpOAuth(activeProjectId, server.id).catch(() =>
      toast.error('Could not disconnect OAuth. Try again.')
    )
  }

  const statusOf = (server: StoredMcpServer) =>
    mcpServerStatus({
      enabled: server.enabled !== false,
      probing: Boolean(mcpProbing[server.id]),
      probeStatus: mcpProbeStatus[server.id]
    })

  const detail = detailId ? servers.find((server) => server.id === detailId) : undefined
  if (detail) {
    return (
      <>
        <McpServerDetail
          server={detail}
          status={statusOf(detail)}
          probeStatus={mcpProbeStatus[detail.id]}
          probeError={mcpProbeError[detail.id]}
          probing={Boolean(mcpProbing[detail.id])}
          tools={mcpTools[detail.id]}
          oauthConnected={Boolean(mcpOAuthConnected[detail.id])}
          oauthConnecting={Boolean(mcpOAuthConnecting[detail.id])}
          onBack={() => onDetailChange(null)}
          onToggle={(next) => toggle(detail, next)}
          onTest={() => void probeMcpServer(detail.id)}
          onEdit={() => mcpDialog.openEdit(detail)}
          onConnect={() => connect(detail)}
          onDisconnect={() => disconnect(detail)}
          onLoadTools={() => void loadMcpTools(detail.id)}
          onRemove={() => {
            onDetailChange(null)
            deleteServer(detail)
          }}
        />
        {mcpDialog.element}
      </>
    )
  }

  const enabledCount = servers.filter((server) => server.enabled !== false).length
  return (
    <>
      <SettingsGroup
        title="Added"
        meta={
          servers.length > 0
            ? `${servers.length} server${servers.length === 1 ? '' : 's'} · ${enabledCount} on`
            : undefined
        }
        actions={
          servers.length > 0 ? (
            <Button type="button" size="xs" variant="secondary" onClick={mcpDialog.openAdd}>
              <Plus size={12} /> Add server
            </Button>
          ) : null
        }
      >
        {servers.length === 0 ? (
          <div
            className={cn(
              'flex flex-col items-center gap-1.5 px-6 py-8 text-center',
              SETTINGS_CARD_CLASS
            )}
          >
            <Server size={18} className="mb-1 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No MCP servers yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Add a stdio, HTTP, or SSE server, or install one from the catalog below. New agent
              chats can then use its tools.
            </p>
            <div className="pt-2">
              <Button type="button" size="xs" variant="secondary" onClick={mcpDialog.openAdd}>
                <Plus size={12} /> Add server
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 @container sm:grid-cols-2">
            {servers.map((server) => {
              const probeStatus = mcpProbeStatus[server.id]
              const enabled = server.enabled !== false
              return (
                <McpServerCard
                  key={server.id}
                  server={server}
                  status={statusOf(server)}
                  toolCount={mcpToolCount(mcpTools[server.id])}
                  canConnect={enabled && probeStatus === 'authRequired'}
                  connecting={Boolean(mcpOAuthConnecting[server.id])}
                  onConnect={() => connect(server)}
                  canRetry={enabled && probeStatus === 'disconnected' && !mcpProbing[server.id]}
                  onRetry={() => void probeMcpServer(server.id)}
                  onToggle={(next) => toggle(server, next)}
                  onOpen={() => onDetailChange(server.id)}
                />
              )
            })}
          </div>
        )}
      </SettingsGroup>
      {mcpDialog.element}
    </>
  )
}
