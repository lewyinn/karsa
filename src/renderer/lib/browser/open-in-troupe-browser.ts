import { newUserBrowserTabId } from '@/lib/browser-api'
import { logFrontendError } from '@/lib/log-api'
import { leaveQuickChatView } from '@/lib/no-project-chat'
import { isTauriContext } from '@/lib/tauri-runtime'
import { sanitizeTerminalUrlToken } from '@/lib/terminal-url-links'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

const LOG_SOURCE = 'open-in-troupe-browser'

/**
 * A host a dev server answers on, written without a scheme
 * (`localhost:4321`, `127.0.0.1:8080/path`, `app.localhost:3000`).
 * Only local hosts get an `http://` prefix: any other bare word with a dot
 * (`package.json`, `v1.2`) is far more likely to be text than a link.
 */
const BARE_LOCAL_HOST =
  /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#]\S*)?$/i

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * The http(s) URL `text` names, or null. Accepts a full URL or a bare local
 * host (`localhost:4321`), with the wrappers and trailing punctuation prose
 * puts around a link (`(http://localhost:3000).`) removed.
 */
export function browsableUrlFrom(text: string | null | undefined): string | null {
  if (!text) return null
  // The cleanup reads the `[` of `[::1]:8000` as a wrapper, so the trimmed
  // text is the fallback.
  return urlFromToken(sanitizeTerminalUrlToken(text)) ?? urlFromToken(text.trim())
}

function urlFromToken(token: string): string | null {
  if (!token || /\s/.test(token)) return null
  const candidate = HAS_SCHEME.test(token)
    ? token
    : BARE_LOCAL_HOST.test(token)
      ? `http://${token}`
      : null
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.href
  } catch {
    return null
  }
}

/**
 * The URL a right-click is about: the http(s) link under the pointer, or else
 * a selection that is exactly one URL (a `localhost:4321` in a code span).
 */
export function browsableUrlForContextMenu(
  target: EventTarget | null,
  selectionText: string
): string | null {
  if (target instanceof Element) {
    const anchor = target.closest('a[href]')
    const fromLink = browsableUrlFrom(anchor?.getAttribute('href'))
    if (fromLink) return fromLink
  }
  return browsableUrlFrom(selectionText)
}

/** Karsa's browser pane exists only in the desktop app. */
export function canOpenInTroupeBrowser(): boolean {
  return isTauriContext()
}

/**
 * Open `url` in a new Karsa browser tab in the active pane. Returns false,
 * with a log line, when there is no desktop browser or no pane to hold it.
 */
export function openUrlInTroupeBrowser(url: string): boolean {
  if (!canOpenInTroupeBrowser()) {
    void logFrontendError({
      level: 'warn',
      source: LOG_SOURCE,
      message: 'Skipped opening a link in the Karsa browser: not the desktop app'
    })
    return false
  }
  const paneId = useWorkspaceStore.getState().activePaneId
  if (!paneId) {
    void logFrontendError({
      level: 'warn',
      source: LOG_SOURCE,
      message: 'Skipped opening a link in the Karsa browser: no active pane'
    })
    return false
  }
  // A quick chat covers the workspace; the new tab must be on screen.
  leaveQuickChatView(LOG_SOURCE)
  const browserTabId = newUserBrowserTabId()
  useBrowserSessionStore.getState().createTab(browserTabId, url)
  useWorkspaceStore.getState().addBrowserTab(browserTabId, paneId)
  // Origin only: a path or query can carry tokens.
  void logFrontendError({
    level: 'info',
    source: LOG_SOURCE,
    message: `Opened ${safeOrigin(url)} in Karsa browser tab ${browserTabId}`
  })
  return true
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return '(invalid url)'
  }
}
