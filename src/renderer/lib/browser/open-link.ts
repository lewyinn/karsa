import { openerApi } from '@/lib/api'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { canOpenInTroupeBrowser, openUrlInTroupeBrowser } from './open-in-troupe-browser'

const WEB_PAGE = /^https?:\/\//i

/**
 * Open a link where the "Open links in" setting says: a Karsa browser tab
 * (desktop app, http and https only) or the system's default browser. A link
 * the Karsa browser cannot take (mailto, the web client, no pane) falls back
 * to the default browser. Throws when the default browser refuses the link.
 *
 * Callers ask for confirmation first where they did before (chat, Markdown
 * and file links go through the "Open this link?" confirm).
 */
export async function openLink(url: string): Promise<void> {
  const { linkOpenMode } = useAppSettingsStore.getState().settings
  if (
    linkOpenMode === 'troupe' &&
    canOpenInTroupeBrowser() &&
    WEB_PAGE.test(url) &&
    openUrlInTroupeBrowser(url)
  ) {
    return
  }

  const result = await openerApi.openUrlWithSystemBrowser(url)
  if (!result.success) {
    throw new Error(result.error || 'Failed to open URL in system browser')
  }
}
