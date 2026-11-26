import { toast } from 'sonner'
import troupeIcon from '@/assets/troupe-app-icon.png'
import { ExternalLink, RefreshCw } from '@/components/icons'
import { rowId } from '@/components/settings/row-id'
import { SETTINGS_CARD_CLASS } from '@/components/settings/SettingsGroup'
import type { StatusTone } from '@/components/settings/StatusWord'
import { Button } from '@/components/ui/button'
import { ProgressBar } from '@/components/ui/progress-bar'
import { Spinner } from '@/components/ui/spinner'
import { confirmInstallAndRestart } from '@/lib/confirm-install-update'
import { logFrontendError } from '@/lib/log-api'
import { APP_UPDATER_DISABLED, AUR_UPDATE_COMMAND } from '@/lib/tauri-updater-api'
import { cn } from '@/lib/utils'
import { type UpdaterErrorSource, useUpdaterActions, useUpdaterState } from '@/stores/updater-store'

export const APP_VERSION = `v${import.meta.env.PACKAGE_VERSION || '0.1.0'}`

const ERROR_COPY: Record<UpdaterErrorSource, string> = {
  check: 'Karsa could not check for updates. Check your connection, then try again.',
  download: 'Karsa could not download the update. Check your connection, then try again.',
  install: 'Karsa could not install the update. Try again, or download it from the release page.'
}

const ERROR_STATUS: Record<UpdaterErrorSource, string> = {
  check: 'Could not check',
  download: 'Download failed',
  install: 'Install failed'
}

/** Release notes shown under an available update (the toast shows the same length). */
const NOTES_PREVIEW_CHARS = 100

const formatChecked = (date: Date): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)

interface CardState {
  dot: StatusTone | 'primary' | null
  line: string
  lineIsProblem?: boolean
  action: React.ReactNode
  band: React.ReactNode
  bandTone?: 'danger'
}

/**
 * Your Karsa version and the whole update flow in one card: one action slot
 * at the right (Check for updates, Download, Install and restart, Try again,
 * or a disabled button with a spinner while it works) and one detail band
 * under the row. Desktop only; the update toasts read the same store.
 */
export function VersionCard({ isAurUpdater }: { isAurUpdater: boolean }): React.JSX.Element {
  const {
    updateAvailable,
    version,
    downloaded,
    downloadProgress,
    skippedVersion,
    isChecking,
    isDownloading,
    isPreparingDownload,
    error,
    errorSource,
    lastChecked,
    releaseNotes,
    isManualUpdateMode
  } = useUpdaterState()
  const { checkForUpdates, downloadUpdate, installAndRestart, skipVersion } = useUpdaterActions()

  const download = (): void => {
    void downloadUpdate().catch((err: unknown) => {
      toast.error('Update download failed')
      void logFrontendError({
        level: 'warn',
        source: 'VersionCard.download',
        message: `Update download failed: ${err instanceof Error ? err.message : String(err)}`
      })
    })
  }
  const install = (): void =>
    isManualUpdateMode ? void installAndRestart() : void confirmInstallAndRestart(version)
  const retry =
    errorSource === 'download' ? download : errorSource === 'install' ? install : checkForUpdates

  const checkButton = (
    <Button
      type="button"
      size="xs"
      variant="secondary"
      className="min-w-36"
      onClick={checkForUpdates}
    >
      <RefreshCw size={12} />
      Check for updates
    </Button>
  )
  const busyButton = (label: string): React.JSX.Element => (
    <Button type="button" size="xs" variant="secondary" className="min-w-36" disabled>
      <Spinner size={12} decorative />
      {label}
    </Button>
  )
  const primaryButton = (label: string, onClick: () => void, icon?: React.ReactNode) => (
    <Button type="button" size="xs" className="min-w-36" onClick={onClick}>
      {icon}
      {label}
    </Button>
  )
  const quietBand = (text: React.ReactNode): React.JSX.Element => (
    <p className="text-xs leading-4 text-muted-foreground">{text}</p>
  )

  const lastCheckedLine = lastChecked
    ? `last checked ${formatChecked(lastChecked)}`
    : 'Not checked yet'
  const restLine = lastChecked ? `Up to date · ${lastCheckedLine}` : lastCheckedLine

  const state: CardState = (() => {
    if (APP_UPDATER_DISABLED) {
      return {
        dot: null,
        line: 'Built by lewyinn · Fork of Troupe (MIT)',
        action: null,
        band: null
      }
    }
    if (error && errorSource) {
      return {
        dot: 'danger',
        line: ERROR_STATUS[errorSource],
        lineIsProblem: true,
        action: (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            className="min-w-36"
            disabled={isChecking}
            onClick={retry}
          >
            <RefreshCw size={12} />
            Try again
          </Button>
        ),
        bandTone: 'danger',
        band: (
          <>
            <p className="text-xs leading-4 text-foreground">{ERROR_COPY[errorSource]}</p>
            <p className="break-words font-mono text-xs leading-4 text-muted-foreground">{error}</p>
          </>
        )
      }
    }
    if (isChecking) {
      return {
        dot: null,
        line: lastChecked ? restLine : 'Not checked yet',
        action: busyButton('Checking…'),
        band: null
      }
    }
    if (updateAvailable && version) {
      if (isAurUpdater) {
        return {
          dot: 'primary',
          line: `Version ${version} is available.`,
          action: null,
          band: (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Update through the AUR with:</span>
              <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
                {AUR_UPDATE_COMMAND}
              </code>
            </div>
          )
        }
      }
      if (downloaded) {
        return {
          dot: 'success',
          line: `Version ${version} is downloaded.`,
          action: primaryButton('Install and restart', install),
          band: quietBand('Karsa restarts to install it, and running terminal sessions close.')
        }
      }
      if (isPreparingDownload) {
        return {
          dot: null,
          line: `Version ${version} is available.`,
          action: busyButton('Preparing…'),
          band: (
            <>
              {quietBand('Backing up your Karsa data before the download starts.')}
              <ProgressBar label="Preparing the update" />
            </>
          )
        }
      }
      if (isDownloading) {
        const percent = Math.round(downloadProgress)
        return {
          dot: null,
          line: `Version ${version} · ${percent}% complete`,
          action: busyButton('Downloading…'),
          band: (
            <ProgressBar
              label="Download progress"
              value={percent}
              valueText={`${percent}% complete`}
              minVisible={1.5}
            />
          )
        }
      }
      if (isManualUpdateMode) {
        return {
          dot: 'primary',
          line: `Version ${version} is available.`,
          action: primaryButton(
            'Open download page',
            () => void installAndRestart(),
            <ExternalLink size={12} />
          ),
          band: quietBand(
            'Automatic update is not available. Download and install it from the release page.'
          )
        }
      }
      const notes = releaseNotes?.trim()
      return {
        dot: 'primary',
        line: `Version ${version} is available.`,
        action: primaryButton('Download', download),
        band: (
          <>
            {notes && (
              <p className="text-xs leading-4 text-secondary-foreground">
                What's new: {notes.slice(0, NOTES_PREVIEW_CHARS)}
                {notes.length > NOTES_PREVIEW_CHARS ? '…' : ''}
              </p>
            )}
            <button
              type="button"
              onClick={() => void skipVersion(version)}
              className="w-fit text-xs font-medium text-secondary-foreground underline underline-offset-[3px] hover:text-foreground"
            >
              Skip this version
            </button>
          </>
        )
      }
    }
    return {
      dot: lastChecked ? 'success' : null,
      line: restLine,
      action: checkButton,
      band: skippedVersion ? (
        <p className="text-xs leading-4 text-muted-foreground">
          You skipped version <span className="font-mono">{skippedVersion}</span>. Karsa offers
          updates again when a newer version is out.
        </p>
      ) : null
    }
  })()

  return (
    <div
      id={rowId('check-updates')}
      data-settings-row=""
      className={cn(
        'scroll-mt-4 overflow-hidden data-[settings-target]:shadow-[inset_2px_0_0_oklch(var(--foreground))]',
        SETTINGS_CARD_CLASS
      )}
    >
      <div className="flex items-center gap-3 p-4">
        <img
          src={troupeIcon}
          alt=""
          width={40}
          height={40}
          draggable={false}
          className="size-10 shrink-0 rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-1.5">
            <span className="text-sm font-medium text-foreground">Karsa</span>
            <span className="font-mono text-xs text-secondary-foreground">{APP_VERSION}</span>
          </p>
          <p className="flex min-w-0 items-center gap-1.5 text-xs leading-4" aria-live="polite">
            {state.dot && (
              <span
                aria-hidden
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  state.dot === 'primary'
                    ? 'bg-primary'
                    : state.dot === 'success'
                      ? 'bg-success'
                      : state.dot === 'danger'
                        ? 'bg-destructive'
                        : 'bg-muted-foreground/60'
                )}
              />
            )}
            <span
              className={cn(
                'truncate tabular-nums',
                state.lineIsProblem
                  ? 'text-destructive'
                  : state.dot === 'primary' || state.dot === 'success'
                    ? state.line.startsWith('Up to date')
                      ? 'text-muted-foreground'
                      : 'text-foreground'
                    : 'text-muted-foreground'
              )}
            >
              {state.line}
            </span>
          </p>
        </div>
        {state.action}
      </div>
      {state.band && (
        <div
          className={cn(
            'flex flex-col gap-2 border-t-[0.5px] border-border px-4 py-3',
            state.bandTone === 'danger' && 'bg-destructive/[0.08]'
          )}
        >
          {state.band}
        </div>
      )}
    </div>
  )
}
