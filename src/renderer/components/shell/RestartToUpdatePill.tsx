import { useEffect, useRef, useState } from 'react'
import { ArrowRight } from '@/components/icons'
import { isTauriContext } from '@/lib/tauri-runtime'
import { APP_UPDATER_DISABLED } from '@/lib/tauri-updater-api'
import { cn } from '@/lib/utils'
import { useUpdaterActions, useUpdaterState } from '@/stores/updater-store'

const NO_DRAG_STYLE = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

/**
 * Background auto-download + crisp "Restart to Update →" pill in the top bar.
 *
 * When a signed update is found and `autoUpdateEnabled` is on, downloads it
 * quietly in the background. Once ready (`downloaded === true`), surfaces a
 * single-click primary pill that installs the update and relaunches Karsa.
 */
export function RestartToUpdatePill({
  className
}: {
  className?: string
}): React.JSX.Element | null {
  const {
    updateAvailable,
    version,
    downloaded,
    isDownloading,
    autoUpdateEnabled,
    isManualUpdateMode,
    error
  } = useUpdaterState()
  const { downloadUpdate, installAndRestart } = useUpdaterActions()
  const [restarting, setRestarting] = useState(false)
  const autoDownloadedVersionRef = useRef<string | null>(null)
  const isDesktop = isTauriContext()

  useEffect(() => {
    if (
      !isDesktop ||
      APP_UPDATER_DISABLED ||
      !autoUpdateEnabled ||
      !updateAvailable ||
      downloaded ||
      isDownloading ||
      isManualUpdateMode ||
      error ||
      !version
    ) {
      return
    }
    if (autoDownloadedVersionRef.current === version) return
    autoDownloadedVersionRef.current = version
    void downloadUpdate()
  }, [
    isDesktop,
    autoUpdateEnabled,
    updateAvailable,
    downloaded,
    isDownloading,
    isManualUpdateMode,
    error,
    version,
    downloadUpdate
  ])

  if (!isDesktop || APP_UPDATER_DISABLED || !updateAvailable || !downloaded || isManualUpdateMode) {
    return null
  }

  const handleRestart = async (): Promise<void> => {
    if (restarting) return
    setRestarting(true)
    try {
      await installAndRestart()
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div
      className={cn('relative z-[101] flex h-11 items-center', className)}
      style={NO_DRAG_STYLE}
      data-testid="restart-to-update-container"
    >
      <button
        type="button"
        onClick={() => void handleRestart()}
        disabled={restarting}
        title={version ? `Install Karsa v${version} and restart` : 'Install update and restart'}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm transition-colors',
          'hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
          'disabled:cursor-wait disabled:opacity-75 cursor-pointer select-none whitespace-nowrap'
        )}
      >
        <span>{restarting ? 'Restarting…' : 'Restart to Update'}</span>
        {!restarting && <ArrowRight size={13} />}
      </button>
    </div>
  )
}
