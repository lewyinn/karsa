import {
  MCP_CATALOG_MAX_QUERY_CHARS,
  MCP_CATALOG_MAX_QUERY_TERMS,
  MCP_REGISTRY_URL,
  type McpCatalogSync
} from '@shared/types/mcp-catalog.types'
import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ExternalLink, Search } from '@/components/icons'
import { CatalogGrid, type CatalogInstall } from '@/components/settings/McpCatalogCard'
import { McpCatalogInstallDialog } from '@/components/settings/McpCatalogInstallDialog'
import {
  SETTINGS_CARD_CLASS,
  SettingsCard,
  SettingsGroup
} from '@/components/settings/SettingsGroup'
import { useSettingsSectionVisible } from '@/components/settings/SettingsLayout'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { SettingsSwitchRow } from '@/components/settings/SettingsSwitchRow'
import { type StatusTone, StatusWord } from '@/components/settings/StatusWord'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useMcpCatalogInstall } from '@/hooks/use-mcp-catalog-install'
import { type McpCatalogResults, useMcpCatalogSearch } from '@/hooks/use-mcp-catalog-search'
import {
  type McpCatalogStatusHandle,
  useMcpCatalogStatus,
  useSearchFollowsCatalog
} from '@/hooks/use-mcp-catalog-status'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { openerApi } from '@/lib/api'
import {
  MCP_INSTALL_BLOCK_TEXT,
  type McpInstallBlock,
  mcpCatalogSampleText,
  mcpCatalogSyncErrorText,
  mcpCatalogSyncText,
  mcpCatalogUpdatedText
} from '@/lib/mcp-catalog-copy'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

const SYNC_TONE: Record<McpCatalogSync['state'], StatusTone> = {
  disabled: 'muted',
  idle: 'success',
  syncing: 'muted',
  failed: 'danger'
}

const count = new Intl.NumberFormat('en-US')

function summary(results: McpCatalogResults): string {
  const noun = results.query
    ? results.total === 1
      ? 'match'
      : 'matches'
    : results.total === 1
      ? 'server'
      : 'servers'
  return `${count.format(results.total)} ${noun}`
}

function openLink(url: string, failure: string): void {
  void openerApi.openUrlWithSystemBrowser(url).then((result) => {
    if (!result.success) toast.error(failure)
  })
}

/** One text line of the placeholder: `line` is the line box, `bar` the bar. */
function PlaceholderLine({ line, bar }: { line: string; bar: string }): React.JSX.Element {
  return (
    <div className={cn('flex items-center', line)}>
      <Skeleton className={cn('max-w-full', bar)} />
    </div>
  )
}

/**
 * Line-for-line stand-in for the source card while the first status loads. The
 * sync row is the real one (disabled), not a skeleton, so its description wraps
 * to the same height at every width. The loaded card can still be taller (a
 * sample note, a long sync error), which is why the card sits below the list.
 */
function CatalogSourcePlaceholder(): React.JSX.Element {
  return (
    <SettingsCard aria-busy="true" data-testid="mcp-catalog-source-placeholder">
      <div aria-hidden className="flex flex-col gap-1 px-4 py-3">
        <PlaceholderLine line="h-5" bar="h-3.5 w-56" />
        <PlaceholderLine line="h-4" bar="h-3 w-44" />
        <PlaceholderLine line="h-4" bar="h-3 w-24" />
      </div>
      {/* Visual stand-in only: the real checked state is unknown until status
          loads, so hide this row from assistive tech. The card is already
          aria-busy. */}
      <div aria-hidden>
        <SettingsSwitchRow
          id="mcp-catalog-sync"
          label="Keep the catalog up to date"
          description="The host downloads the official MCP Registry and checks it for changes."
          checked
          disabled
          onToggle={() => {}}
        />
      </div>
    </SettingsCard>
  )
}

function CatalogSource({ state, setSync }: McpCatalogStatusHandle): React.JSX.Element {
  if (state.status === 'loading') return <CatalogSourcePlaceholder />
  if (state.status === 'unavailable') {
    return (
      <p className="text-xs text-muted-foreground">
        Karsa couldn't check where the catalog comes from.
      </p>
    )
  }
  const { catalog, requested } = state
  const sample = mcpCatalogSampleText(catalog)
  const sync = mcpCatalogSyncText(catalog)
  return (
    <SettingsCard>
      <div className="flex flex-col gap-1 px-4 py-3 text-xs text-muted-foreground">
        <p className="text-xs font-medium text-foreground">
          From the{' '}
          <Button
            type="button"
            variant="link"
            className="h-auto gap-1 p-0 text-xs"
            onClick={() => openLink(MCP_REGISTRY_URL, "Couldn't open the MCP Registry link.")}
          >
            official MCP Registry
            <ExternalLink size={12} aria-hidden />
          </Button>
        </p>
        <p>{mcpCatalogUpdatedText(catalog.updatedAt)}</p>
        {sample && <p>{sample}</p>}
        {sync && (
          <StatusWord
            tone={SYNC_TONE[catalog.sync.state]}
            pending={catalog.sync.state === 'syncing'}
          >
            {sync}
          </StatusWord>
        )}
      </div>
      <SettingsSwitchRow
        id="mcp-catalog-sync"
        label="Keep the catalog up to date"
        description="The host downloads the official MCP Registry and checks it for changes."
        checked={requested ?? catalog.sync.state !== 'disabled'}
        disabled={requested !== null}
        onToggle={(enabled) => {
          void setSync(enabled).then((result) => {
            if (!result.success) toast.error(mcpCatalogSyncErrorText(result.code))
          })
        }}
      />
    </SettingsCard>
  )
}

/**
 * "From the catalog": a search well, the matching servers as a grid of cards,
 * Load more under the grid, and the card that says where the catalog comes
 * from and whether it stays up to date.
 */
export function McpCatalogBrowser(): React.JSX.Element {
  const visible = useSettingsSectionVisible()
  const [query, setQuery] = useState('')
  const search = useMcpCatalogSearch(query, visible)
  const { state, canLoadMore, loadMore, retry } = search
  const status = useMcpCatalogStatus(visible)
  useSearchFollowsCatalog(status.state.status === 'ready' ? status.state.catalog : null, search)
  const hintId = useId()
  const install = useMcpCatalogInstall()
  const admitsWrites = useServerAdmitsRemoteWrites()
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const mcpServers = useAcpStore((state) => state.mcpServers)
  const mcpServersLoaded = useAcpStore((state) => state.mcpServersLoaded)
  const installed = useMemo(
    () => new Set(mcpServers.flatMap((server) => (server.catalog ? [server.catalog.name] : []))),
    [mcpServers]
  )
  const block: McpInstallBlock | null = !admitsWrites
    ? 'view-only'
    : !isTauriContext() && !activeProjectId
      ? 'no-project'
      : !mcpServersLoaded
        ? 'loading'
        : null
  const cardInstall: CatalogInstall = {
    installed,
    block: block && { reason: block, hintId },
    onInstall: install.start
  }
  const syncOff = status.state.status === 'ready' && status.state.catalog.sync.state === 'disabled'

  const results =
    state.status === 'ready' ? state.results : state.status === 'loading' ? state.previous : null
  const more = state.status === 'ready' ? state.more : 'idle'

  return (
    <SettingsGroup
      title="From the catalog"
      meta={results ? <span aria-live="polite">{summary(results)}</span> : undefined}
      footnote={block && <span id={hintId}>{MCP_INSTALL_BLOCK_TEXT[block]}</span>}
    >
      {/* The source card is not above the search box: its height depends on the
          status, which arrives after first paint and changes while the page is
          open (sample note, sync progress, a sync error of any length), so above
          the box it would push the box and the list down. */}
      <div className="relative">
        <Search
          size={14}
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={MCP_CATALOG_MAX_QUERY_CHARS}
          placeholder="Search the MCP catalog"
          aria-label="Search the MCP catalog"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          className={cn(
            'h-8 w-full rounded-md border-0 bg-muted pl-8 pr-8 text-xs font-medium text-foreground placeholder:text-muted-foreground',
            'pointer-coarse:h-11 pointer-coarse:text-base',
            FOCUS_RING_CLASS
          )}
        />
        {state.status === 'loading' && results !== null && (
          <Spinner
            size={13}
            label="Searching"
            className="absolute right-2.5 top-1/2 -translate-y-1/2"
          />
        )}
      </div>

      {state.status === 'too-many-terms' ? (
        <SettingsNotice tone="warning">
          Search with {MCP_CATALOG_MAX_QUERY_TERMS} words or fewer.
        </SettingsNotice>
      ) : state.status === 'failed' ? (
        <SettingsNotice
          tone="danger"
          action={
            <Button type="button" size="xs" variant="secondary" onClick={retry}>
              Try again
            </Button>
          }
        >
          Karsa couldn't load the MCP catalog.
        </SettingsNotice>
      ) : results === null ? (
        <div
          className={cn(
            'flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground',
            SETTINGS_CARD_CLASS
          )}
        >
          <Spinner size={13} decorative />
          Loading the catalog…
        </div>
      ) : (
        <>
          {results.updatedAt === null ? (
            <SettingsNotice tone="warning">
              No catalog is loaded yet, so there is nothing to browse.
            </SettingsNotice>
          ) : results.rows.length === 0 ? (
            <div className={cn('flex flex-col items-center gap-3 px-4 py-8', SETTINGS_CARD_CLASS)}>
              <p className="text-xs text-muted-foreground">No servers match "{results.query}".</p>
              <Button type="button" size="xs" variant="secondary" onClick={() => setQuery('')}>
                Clear search
              </Button>
            </div>
          ) : (
            <div aria-busy={state.status === 'loading'}>
              <CatalogGrid
                rows={results.rows}
                install={cardInstall}
                onNearEnd={canLoadMore && more === 'idle' ? loadMore : undefined}
              />
            </div>
          )}
          {results.nextCursor !== null && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {canLoadMore && more === 'loading' && <Spinner size={13} label="Loading more" />}
              {canLoadMore && more !== 'loading' && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="text-secondary-foreground"
                  onClick={loadMore}
                >
                  {more === 'failed' ? 'Try again' : 'Load more'}
                  {more !== 'failed' && <ChevronDown size={12} />}
                </Button>
              )}
              <span>
                Showing {count.format(results.rows.length)} of {count.format(results.total)}.
                {!canLoadMore && ' Search to narrow the list.'}
              </span>
              {more === 'failed' && <span>Couldn't load more servers.</span>}
            </div>
          )}
        </>
      )}
      <CatalogSource {...status} />
      <McpCatalogInstallDialog
        install={install}
        onEnableSync={
          syncOff
            ? () => {
                void status.setSync(true).then((result) => {
                  if (!result.success) toast.error(mcpCatalogSyncErrorText(result.code))
                })
              }
            : null
        }
      />
    </SettingsGroup>
  )
}
