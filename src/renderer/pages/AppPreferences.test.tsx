import { PersistenceKeys } from '@shared/types/persistence.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acpApi } from '@/lib/api'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { AppPreferencesModal } from './AppPreferences'

/**
 * GH-539: the App Preferences switch/select are the ONLY write path for the
 * auto-save settings. These tests pin the wiring (click → store value), which
 * no auto-save unit test can reach because they inject settings directly.
 */

const mockWriteDebounced = vi.fn().mockResolvedValue(undefined)
const mockWrite = vi.fn().mockResolvedValue({ success: true, data: undefined })
const mockLogFrontendError = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/api', () => ({
  // The settings window draws the Windows and Linux window controls on desktop.
  windowApi: {
    onMaximizeChange: vi.fn(() => () => undefined),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn()
  },
  acpApi: {
    setTurnTimeout: vi.fn().mockResolvedValue({ success: true }),
    setTurnIdleTimeout: vi.fn().mockResolvedValue({ success: true }),
    setSessionNewTimeout: vi.fn().mockResolvedValue({ success: true }),
    setSessionReopenTimeout: vi.fn().mockResolvedValue({ success: true }),
    setAgentIdleWindow: vi.fn().mockResolvedValue(undefined),
    getAgentIdleWindow: vi.fn().mockResolvedValue({ secs: 1800, source: 'default' }),
    getSubagentSettings: vi
      .fn()
      .mockResolvedValue({ enabled: true, maxRunning: 4, maxDepth: 2, profiles: [] }),
    setSubagentSettings: vi.fn()
  },
  logApi: {
    revealLogDir: vi.fn(),
    exportLogFile: vi.fn(),
    copyLogContents: vi.fn(),
    exportLogToDefault: vi.fn()
  },
  shellApi: {
    getAvailableShells: vi.fn().mockResolvedValue({
      success: true,
      data: { default: null, available: [] }
    })
  },
  persistenceApi: {
    read: vi.fn().mockResolvedValue({ success: true, data: null }),
    write: (...args: unknown[]) => mockWrite(...args),
    writeDebounced: (...args: unknown[]) => mockWriteDebounced(...args)
  }
}))

// L-28: the screen reader toggle writes one `info` boundary entry; the real
// facade would invoke Tauri or POST to the server.
vi.mock('@/lib/log-api', () => ({
  logFrontendError: (...args: unknown[]) => mockLogFrontendError(...args)
}))

// gh-1105: the web-only ServerSection mounts on web-variant renders and
// would fetch `/server/config` — keep it in its loading state (never-
// resolving) so it adds no boundary-log calls or controls to these pages.
vi.mock('@/lib/web-setup-api', () => ({
  webSetupApi: {
    getStatus: vi.fn(() => new Promise(() => {})),
    validate: vi.fn(() => new Promise(() => {})),
    apply: vi.fn(() => new Promise(() => {})),
    getServerConfig: vi.fn(() => new Promise(() => {})),
    applyServerConfig: vi.fn(() => new Promise(() => {}))
  }
}))

vi.mock('@/lib/tauri-updater-api', () => ({
  APP_UPDATER_DISABLED: false,
  isAurUpdateMode: () => false
}))

// Story 8 (web honesty): the Updates + Diagnostics desktop-only controls
// are gated with isTauriContext(). Mutable ref defaults to desktop so the
// existing control tests keep running in desktop mode; the web-mode tests
// flip it.
const { tauriRef } = vi.hoisted(() => ({ tauriRef: { current: true as boolean } }))

vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri-runtime')>()),
  isTauriContext: () => tauriRef.current
}))

vi.mock('@/stores/updater-store', () => ({
  useUpdaterState: () => ({
    isChecking: false,
    updateAvailable: false,
    version: '0.4.8',
    lastChecked: null,
    autoUpdateEnabled: false,
    skippedVersion: null,
    error: null,
    isManualUpdateMode: false,
    updateChannel: 'stable'
  }),
  useUpdaterActions: () => ({
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installAndRestart: vi.fn(),
    setAutoUpdateEnabled: vi.fn(),
    setUpdateChannel: vi.fn()
  })
}))

vi.mock('@/stores/keyboard-shortcuts-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/keyboard-shortcuts-store')>()
  return {
    ...actual,
    useKeyboardShortcutsStore: vi.fn((selector: (s: { shortcuts: unknown[] }) => unknown) =>
      selector({
        shortcuts: [
          {
            id: 'commandPalette',
            label: 'Command Palette',
            description: 'Open the command palette for quick actions',
            defaultKey: 'ctrl+k'
          },
          {
            id: 'newTerminal',
            label: 'Agent Launcher',
            description: 'Show the agent launcher prompt in the active pane',
            defaultKey: 'ctrl+t'
          },
          {
            id: 'newBrowserTab',
            label: 'New Browser Tab',
            description: 'Create a new browser tab',
            defaultKey: 'ctrl+shift+n'
          }
        ]
      })
    )
  }
})

const mockResetAllShortcuts = vi.fn().mockResolvedValue(undefined)
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  useUpdateShortcut: () => vi.fn(),
  useResetShortcut: () => vi.fn(),
  useResetAllShortcuts: () => mockResetAllShortcuts
}))

vi.mock('@/hooks/use-agent-skills', () => ({
  useAgentSkills: () => ({ skills: [], loading: false, reload: () => {} })
}))

vi.mock('@/components/settings/AcpAgentsSettings', () => ({
  AcpAgentsSettings: () => null
}))

vi.mock('@/components/settings/McpServersSettings', () => ({
  McpServersSettings: () => null
}))

// Every page stays mounted (hidden), so the Accounts page would list accounts
// over a real `/ws` on each render; its late failures land in later tests' log mock.
vi.mock('@/components/settings/provider/ProviderSettings', () => ({
  ProviderSettings: () => null
}))

vi.mock('@/components/settings/provider/CodexProviderSettings', () => ({
  CodexProviderSettings: () => null
}))

vi.mock('@/components/settings/provider/AntigravityProviderSettings', () => ({
  AntigravityProviderSettings: () => null
}))

vi.mock('@/components/settings/BrowserPolicySettings', () => ({
  BrowserAppPolicy: () => null
}))

// Radix Select content does not render under jsdom. A native select keeps
// the wiring (label → control → store) testable.
vi.mock('@/components/settings/SettingsSelect', () => ({
  SettingsSelect: ({
    options,
    value,
    onValueChange,
    disabled,
    id,
    'aria-label': ariaLabel,
    'aria-describedby': ariaDescribedBy
  }: {
    options: ReadonlyArray<{ value: string; label: string }>
    value?: string
    onValueChange?: (value: string) => void
    disabled?: boolean
    id?: string
    'aria-label'?: string
    'aria-describedby'?: string
  }) => (
    <select
      id={id}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}))

/** Open a Preferences page from the sidebar. */
function goTo(page: string): void {
  const nav = screen.getByRole('navigation', { name: 'Settings pages' })
  fireEvent.click(within(nav).getByRole('button', { name: page }))
}

function renderPage(): ReturnType<typeof render> {
  useSettingsModalStore.setState({ view: 'app', appPage: null })
  return render(
    <MemoryRouter>
      <AppPreferencesModal />
    </MemoryRouter>
  )
}

describe('AppPreferences editor auto-save controls (GH-539)', () => {
  beforeEach(() => {
    tauriRef.current = true
    vi.clearAllMocks()
    useAppSettingsStore.setState({ settings: { ...DEFAULT_APP_SETTINGS }, isLoaded: true })
  })

  it('is one select: a delay turns auto save on, Off turns it off', async () => {
    renderPage()
    goTo('Preferences')

    const select = await screen.findByLabelText('Auto save')
    expect(select).toHaveValue('1000')

    fireEvent.change(select, { target: { value: '2000' } })
    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.editorAutoSave).toBe(true)
      expect(useAppSettingsStore.getState().settings.editorAutoSaveDelayMs).toBe(2000)
    })
    expect(mockWriteDebounced).toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Auto save'), { target: { value: 'off' } })
    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.editorAutoSave).toBe(false)
    })
    // Off keeps the chosen delay for the next time auto save is on.
    expect(useAppSettingsStore.getState().settings.editorAutoSaveDelayMs).toBe(2000)
  })

  it('has no second delay row', async () => {
    renderPage()
    goTo('Preferences')

    await screen.findByLabelText('Auto save')
    expect(screen.queryByLabelText('Auto save delay')).not.toBeInTheDocument()
  })
})

describe('AppPreferences idle chat window', () => {
  beforeEach(() => {
    tauriRef.current = true
    vi.clearAllMocks()
    useAppSettingsStore.setState({ settings: { ...DEFAULT_APP_SETTINGS }, isLoaded: true })
  })

  it('saves Keep idle chats and pushes the window to the host', async () => {
    renderPage()
    goTo('Agents')
    fireEvent.change(await screen.findByLabelText('Close idle chats after'), {
      target: { value: '7200' }
    })

    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.agentIdleWindowSecs).toBe(7200)
      expect(acpApi.setAgentIdleWindow).toHaveBeenCalledWith(7200)
    })
  })
})

describe('AppPreferences Sub-agents page', () => {
  const ENABLE_SWITCH = { name: 'Let agents start other agents' }

  beforeEach(() => {
    vi.clearAllMocks()
    useAppSettingsStore.setState({ settings: { ...DEFAULT_APP_SETTINGS }, isLoaded: true })
    // jsdom has no scrollIntoView; a search jump scrolls to its row.
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  it.each([
    ['desktop', true],
    ['web', false]
  ])('lists Sub-agents right after Agents on %s', (_runtime, isTauri) => {
    tauriRef.current = isTauri
    renderPage()

    const nav = screen.getByRole('navigation', { name: 'Settings pages' })
    const pages = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(pages.slice(pages.indexOf('Agents'), pages.indexOf('Agents') + 2)).toEqual([
      'Agents',
      'Sub-agents'
    ])
  })

  it('opens a page that holds the sub-agent settings', async () => {
    tauriRef.current = true
    renderPage()
    goTo('Sub-agents')

    expect(screen.getByRole('heading', { level: 2, name: 'Sub-agents' })).toBeInTheDocument()
    expect(
      screen.getByText('Agents your chats can hand work to, and what each one runs with.')
    ).toBeInTheDocument()
    expect(await screen.findByRole('switch', ENABLE_SWITCH)).toBeInTheDocument()
  })

  it('no longer shows the sub-agent settings on Agent chats', async () => {
    tauriRef.current = true
    renderPage()
    goTo('Agents')

    expect(
      await screen.findByRole('combobox', { name: 'Close idle chats after' })
    ).toBeInTheDocument()
    await screen.findByRole('switch', { ...ENABLE_SWITCH, hidden: true })
    expect(screen.queryByRole('switch', ENABLE_SWITCH)).toBeNull()
  })

  it('jumps from a "sub-agent" search to the Sub-agents page', async () => {
    tauriRef.current = true
    renderPage()
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'sub-agent' } })

    const nav = screen.getByRole('navigation', { name: 'Settings pages' })
    fireEvent.click(within(nav).getByRole('button', { name: /Let agents start other agents/ }))

    expect(screen.getByRole('heading', { level: 2, name: 'Sub-agents' })).toBeInTheDocument()
    const target = await screen.findByRole('switch', ENABLE_SWITCH)
    await waitFor(() =>
      expect(target.closest('[data-settings-target]')).toHaveAttribute(
        'id',
        'setting-subagent-enabled'
      )
    )
  })
})

describe('AppPreferences notification switches (issue #865)', () => {
  beforeEach(() => {
    tauriRef.current = true
    vi.clearAllMocks()
    useAppSettingsStore.setState({ settings: { ...DEFAULT_APP_SETTINGS }, isLoaded: true })
  })

  it('renders the three notification switches and writes each setting', async () => {
    renderPage()
    goTo('Preferences')
    const terminal = await screen.findByRole('switch', {
      name: 'Notify when a terminal agent finishes'
    })
    const finished = screen.getByRole('switch', {
      name: 'Notify when an agent chat turn finishes'
    })
    const needsYou = screen.getByRole('switch', { name: 'Notify when an agent chat needs you' })

    expect(terminal).toHaveAttribute('aria-checked', 'true')
    expect(finished).toHaveAttribute('aria-checked', 'true')
    expect(needsYou).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(terminal)
    fireEvent.click(finished)
    fireEvent.click(needsYou)

    await waitFor(() => {
      const settings = useAppSettingsStore.getState().settings
      expect(settings.notifyOnTerminalIdle).toBe(false)
      expect(settings.notifyOnAgentChatTurnFinished).toBe(false)
      expect(settings.notifyOnAgentChatNeedsYou).toBe(false)
    })
  })
})

// Story 8 (web honesty) → issue #843: desktop-only Preferences entries are
// now HIDDEN on web (not disabled-with-title). Copy Log Contents stays
// available (works on web).
describe('AppPreferences web honesty gates (Story 8)', () => {
  beforeEach(() => {
    tauriRef.current = true
    vi.clearAllMocks()
    useAppSettingsStore.setState({ settings: { ...DEFAULT_APP_SETTINGS }, isLoaded: true })
  })

  function renderWeb(): void {
    tauriRef.current = false
    renderPage()
  }

  it('hides the update controls on web and shows the server version on About', async () => {
    renderWeb()

    const nav = screen.getByRole('navigation', { name: 'Settings pages' })
    expect(within(nav).queryByRole('button', { name: 'Updates' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Check for updates/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Release channel')).not.toBeInTheDocument()

    goTo('About')
    expect(await screen.findByText(/^Karsa /)).toBeInTheDocument()
    expect(screen.getByText(/Running in browser mode/i)).toBeInTheDocument()
  })

  it('hides the log folder and file exports on web', async () => {
    renderWeb()
    goTo('About')

    await screen.findByRole('button', { name: 'Copy log contents' })
    expect(screen.queryByRole('button', { name: 'Show log folder' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Export log file…' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Export log to Downloads' })
    ).not.toBeInTheDocument()
  })

  it('keeps Close idle chats after editable on web and leaves the other timeouts read-only', async () => {
    renderWeb()
    goTo('Agents')
    expect(await screen.findByText('Set on the server.')).toBeInTheDocument()
    const keep = screen.getByLabelText('Close idle chats after')
    expect(keep).toBeEnabled()
    expect(screen.queryByLabelText('If an answer goes quiet')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Longest one answer')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Start a new chat')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Open a saved chat')).not.toBeInTheDocument()

    fireEvent.change(keep, { target: { value: '7200' } })
    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.agentIdleWindowSecs).toBe(7200)
      expect(acpApi.setAgentIdleWindow).toHaveBeenCalledWith(7200)
    })
  })

  it('hides the New Browser Tab shortcut row on web but keeps other shortcuts', async () => {
    renderWeb()
    goTo('Keyboard shortcuts')
    await screen.findByText('Command Palette')
    expect(screen.queryByText('New Browser Tab')).not.toBeInTheDocument()
    expect(screen.getByText('Agent Launcher')).toBeInTheDocument()
  })

  it('keeps Copy log enabled on web (works in the browser)', async () => {
    renderWeb()
    goTo('About')

    const copy = await screen.findByRole('button', { name: 'Copy log contents' })
    expect(copy).toBeEnabled()
  })

  it('offers the update controls ungated on desktop', async () => {
    renderPage()
    goTo('About')

    const check = await screen.findByRole('button', { name: /Check for updates/ })
    expect(check).toBeEnabled()
    expect(check).not.toHaveAttribute('title')

    goTo('About')
    const reveal = screen.getByRole('button', { name: 'Show log folder' })
    expect(reveal).toBeEnabled()
    expect(reveal).not.toHaveAttribute('title')
  })
})

// L-28 (spec-mobile-terminal-screen-reader-mode): a Switch in Terminal
// Appearance, between Terminal Renderer and Preview. The row is shared by the
// desktop and web roots (the same modal), so every behaviour runs on both.
describe.each([
  ['desktop', true],
  ['web', false]
])('AppPreferences screen reader mode (L-28) on %s', (_name, isTauri) => {
  beforeEach(() => {
    tauriRef.current = isTauri
    vi.clearAllMocks()
    useAppSettingsStore.setState({ settings: { ...DEFAULT_APP_SETTINGS }, isLoaded: true })
  })

  async function findSwitch(): Promise<HTMLElement> {
    goTo('Terminal')
    return screen.findByRole('switch', { name: 'Screen reader mode' })
  }

  it('renders an unchecked switch that explains it applies to new terminals', async () => {
    renderPage()

    const toggle = await findSwitch()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).toHaveAttribute('data-state', 'unchecked')

    const describedBy = toggle.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const description = document.getElementById(describedBy as string)
    expect(description).not.toBeNull()
    expect(description).toHaveTextContent('Changes apply to new terminals.')
    expect(description).toHaveTextContent(/repeat typed characters/i)
  })

  it('sits under New terminals, after Default shell and before the Advanced card', async () => {
    renderPage()

    const toggle = await findSwitch()
    const shell = screen.getByLabelText('Default shell')
    const advanced = screen.getByRole('button', { name: /Advanced/ })

    expect(shell.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(toggle.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('toggles through the label as well as the switch', async () => {
    renderPage()

    await findSwitch()
    fireEvent.click(screen.getByText('Screen reader mode', { selector: 'label' }))

    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(true)
    })
  })

  it('persists the setting and writes one info boundary log per toggle', async () => {
    renderPage()

    const toggle = await findSwitch()
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(true)
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(mockWriteDebounced).toHaveBeenCalledWith(
      PersistenceKeys.appSettings,
      expect.objectContaining({ terminalScreenReaderMode: true })
    )
    await waitFor(() => {
      expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    })
    expect(mockLogFrontendError).toHaveBeenLastCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'AppPreferences.terminalScreenReaderMode',
        message: expect.stringMatching(/enabled.*new terminals.*3467/i)
      })
    )

    fireEvent.click(toggle)

    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(false)
    })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(mockWriteDebounced).toHaveBeenLastCalledWith(
      PersistenceKeys.appSettings,
      expect.objectContaining({ terminalScreenReaderMode: false })
    )
    await waitFor(() => {
      expect(mockLogFrontendError).toHaveBeenCalledTimes(2)
    })
    expect(mockLogFrontendError).toHaveBeenLastCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'AppPreferences.terminalScreenReaderMode',
        message: expect.stringMatching(/disabled/i)
      })
    )
  })

  it('renders checked when the setting is already on', async () => {
    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS, terminalScreenReaderMode: true },
      isLoaded: true
    })
    renderPage()

    expect(await findSwitch()).toHaveAttribute('aria-checked', 'true')
  })

  it('returns to off after Reset Settings', async () => {
    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS, terminalScreenReaderMode: true },
      isLoaded: true
    })
    renderPage()

    const toggle = await findSwitch()
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    goTo('About')
    // The page trigger and the confirm share the label; the confirm is the second.
    fireEvent.click(screen.getByRole('button', { name: 'Reset settings' }))
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Reset settings' })).toHaveLength(2)
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset settings' })[1] as HTMLElement)

    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(false)
    })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(mockWrite).toHaveBeenCalledWith(
      PersistenceKeys.appSettings,
      expect.objectContaining({ terminalScreenReaderMode: false })
    )
  })
})
