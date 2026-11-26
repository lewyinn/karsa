import { BROWSER_ANCHORS } from '@/components/settings/browser-policy-copy'
import { rowId } from '@/components/settings/row-id'
import { isTranslucentRailSupported } from '@/hooks/use-translucent-rail'
import type { SettingsSearchEntry } from '@/lib/settings-search'
import { isTauriContext } from '@/lib/tauri-runtime'

// Rows that exist on one runtime only: the updater is desktop-only (issue
// #843), the Karsa browser (Open links in) is desktop-only, and the server
// form is web-only (gh-1105).
const DESKTOP_ONLY_ANCHORS = new Set([
  rowId('link-open-mode'),
  rowId('check-updates'),
  rowId('auto-update'),
  rowId('release-channel')
])
const WEB_ONLY_ANCHORS = new Set([
  rowId('server-qr'),
  rowId('server-config'),
  rowId('server-version')
])

const APP_PREF_SEARCH_INDEX: SettingsSearchEntry[] = [
  // Preferences
  {
    categoryId: 'preferences',
    label: 'Theme',
    description: 'Pick the colors for the whole app.',
    keywords: ['theme', 'color theme', 'dark', 'light', 'appearance', 'colors'],
    anchorId: rowId('color-theme')
  },
  {
    categoryId: 'preferences',
    label: 'Interface zoom',
    description: 'Make everything larger or smaller (50–300%).',
    keywords: ['ui zoom', 'zoom', 'interface scale', 'window zoom', 'magnify'],
    anchorId: rowId('ui-zoom')
  },
  {
    categoryId: 'preferences',
    label: 'Translucent sidebar',
    description: 'Show the desktop through the project sidebar (macOS).',
    keywords: ['translucent', 'transparent', 'vibrancy', 'glass', 'blur', 'sidebar', 'appearance'],
    anchorId: rowId('translucent-rail')
  },
  {
    categoryId: 'preferences',
    label: 'Notify when a terminal agent finishes',
    description: 'Notify when a long-running terminal tab goes quiet.',
    keywords: ['notification', 'terminal', 'idle', 'agent'],
    anchorId: rowId('notify-terminal-idle')
  },
  {
    categoryId: 'preferences',
    label: 'Notify when an agent chat turn finishes',
    description: 'Notify when an agent chat turn ends and nothing is queued.',
    keywords: ['notification', 'chat', 'finished', 'agent'],
    anchorId: rowId('notify-turn-finished')
  },
  {
    categoryId: 'preferences',
    label: 'Notify when an agent chat needs you',
    description: 'Notify when an agent waits for your approval or an answer.',
    keywords: ['notification', 'approval', 'permission', 'question'],
    anchorId: rowId('notify-needs-you')
  },
  {
    categoryId: 'preferences',
    label: 'Open links in',
    description: 'Where links in chats, terminals, Markdown and files open.',
    keywords: ['url', 'links', 'browser', 'open', 'default browser'],
    anchorId: rowId('link-open-mode')
  },
  {
    categoryId: 'preferences',
    label: 'Auto save',
    description: 'Save editor files after you stop typing, and how soon.',
    keywords: ['editor', 'autosave', 'auto save', 'save', 'delay', 'timeout'],
    anchorId: rowId('editor-auto-save')
  },
  {
    categoryId: 'preferences',
    label: 'Default project color',
    description: 'New projects start with this color.',
    keywords: ['theme', 'appearance', 'color', 'new project'],
    anchorId: rowId('default-project-color')
  },
  // Terminal
  {
    categoryId: 'terminal',
    label: 'Font size',
    description: 'Terminal text size.',
    keywords: ['text size', 'zoom'],
    anchorId: rowId('terminal-font-size')
  },
  {
    categoryId: 'terminal',
    label: 'Default shell',
    description: 'Set the default shell for new terminals.',
    keywords: ['bash', 'zsh', 'powershell', 'fish'],
    anchorId: rowId('default-shell')
  },
  {
    categoryId: 'terminal',
    label: 'Screen reader mode',
    description: 'Make terminal output readable by screen readers.',
    keywords: ['accessibility', 'a11y', 'talkback', 'voiceover', 'nvda'],
    anchorId: rowId('terminal-screen-reader-mode')
  },
  {
    categoryId: 'terminal',
    label: 'Renderer',
    description: 'GPU-accelerated rendering for terminal output.',
    keywords: ['webgl', 'dom', 'gpu'],
    anchorId: rowId('terminal-renderer')
  },
  {
    categoryId: 'terminal',
    label: 'Scrollback',
    description: 'Number of lines to keep in terminal history.',
    keywords: ['history', 'lines', 'memory', 'buffer'],
    anchorId: rowId('terminal-scrollback')
  },
  {
    categoryId: 'terminal',
    label: 'Automatic completion refresh',
    description: 'Updates command suggestions while you type.',
    keywords: ['completion', 'suggestions', 'tab', 'autocomplete'],
    anchorId: rowId('terminal-automatic-completion-refresh')
  },
  {
    categoryId: 'terminal-profiles',
    label: 'Terminal profiles',
    description: 'Save a shell with arguments, start folder and environment variables.',
    keywords: ['profile', 'preset', 'shell', 'env', 'environment', 'cwd', 'folder', 'arguments']
  },
  // Agents
  {
    categoryId: 'provider',
    label: 'Accounts',
    description: 'Add accounts, sign in, and choose the default account for each agent.',
    keywords: [
      'provider',
      'account',
      'claude',
      'codex',
      'antigravity',
      'login',
      'sign in',
      'subscription',
      'switch'
    ]
  },
  {
    categoryId: 'provider',
    label: 'Usage and limits',
    description: 'See how much of each limit every account has used.',
    keywords: ['usage', 'limit', 'rate limit', 'quota', 'reset']
  },
  {
    categoryId: 'ai-agents',
    label: 'Available agents',
    description: 'View ACP agent availability and warm/auth status.',
    keywords: ['acp', 'agent', 'coding assistant'],
    anchorId: 'settings-available-agents'
  },
  {
    categoryId: 'ai-agents',
    label: 'Close idle chats after',
    description: 'How long a chat stays open after you leave it.',
    keywords: ['timeout', 'session closed', 'idle', 'keep idle chats', 'leave chat'],
    anchorId: rowId('agent-idle-window')
  },
  {
    categoryId: 'ai-agents',
    label: 'Suggest automations from repeated chats',
    description: 'Offer to schedule something you ask on several days.',
    keywords: ['automation', 'schedule', 'repeat', 'suggestion', 'recurring'],
    anchorId: rowId('suggest-automations')
  },
  {
    categoryId: 'ai-agents',
    label: 'If an answer goes quiet',
    description: 'Cancel an answer that stops sending updates.',
    keywords: ['timeout', 'idle', 'silent', 'turn'],
    anchorId: rowId('acp-turn-idle-timeout')
  },
  {
    categoryId: 'ai-agents',
    label: 'Longest one answer',
    description: 'Stop an answer that is still writing.',
    keywords: ['timeout', 'turn', 'long answer'],
    anchorId: rowId('acp-turn-timeout')
  },
  {
    categoryId: 'ai-agents',
    label: 'Start a new chat',
    description: 'How long to wait for an agent to start.',
    keywords: ['timeout', 'new chat', 'start'],
    anchorId: rowId('acp-session-new-timeout')
  },
  {
    categoryId: 'ai-agents',
    label: 'Open a saved chat',
    description: 'How long to wait to open a saved chat.',
    keywords: ['timeout', 'resume', 'reopen', 'history'],
    anchorId: rowId('acp-session-reopen-timeout')
  },
  {
    categoryId: 'subagents',
    label: 'Let agents start other agents',
    description: 'An agent chat can hand parts of a task to your other installed agents.',
    keywords: [
      'subagent',
      'sub-agent',
      'delegate',
      'orchestrator',
      'codex',
      'gemini',
      'child agent'
    ],
    anchorId: rowId('subagent-enabled')
  },
  {
    categoryId: 'subagents',
    label: 'Max running sub-agents',
    description: 'Per chat. Extra starts are refused until one finishes.',
    keywords: ['subagent', 'sub-agent', 'limit', 'parallel', 'capacity'],
    anchorId: rowId('subagent-max-running')
  },
  {
    categoryId: 'subagents',
    label: 'Max depth',
    description: 'How many levels of sub-agents can start their own sub-agents.',
    keywords: ['subagent', 'sub-agent', 'depth', 'nesting', 'levels'],
    anchorId: rowId('subagent-max-depth')
  },
  {
    categoryId: 'subagents',
    label: 'Sub-agent profiles',
    description: 'Each profile runs one agent with its own model, thinking level, mode and note.',
    keywords: ['subagent', 'sub-agent', 'profile', 'model', 'thinking', 'effort', 'mode', 'note'],
    anchorId: rowId('subagent-profiles')
  },
  {
    categoryId: 'subagents',
    label: 'Sub-agent approvals',
    description: 'Answer permission prompts in the chat, or let Karsa allow them.',
    keywords: ['subagent', 'sub-agent', 'approvals', 'allow', 'bypass', 'permissions', 'auto'],
    anchorId: rowId('subagent-profiles')
  },
  {
    categoryId: 'skills',
    label: 'Skills',
    description: 'See skills installed for every project and for the open project.',
    keywords: ['skill', 'agents', 'SKILL.md', 'slash']
  },
  {
    categoryId: 'mcp-servers',
    label: 'MCP servers',
    description: 'Manage global stdio, HTTP, and SSE servers, or browse the MCP catalog.',
    keywords: [
      'mcp',
      'model context protocol',
      'stdio',
      'http',
      'sse',
      'catalog',
      'registry',
      'browse',
      'discover',
      'marketplace',
      'connector'
    ]
  },
  {
    categoryId: 'browser',
    label: 'Shared agent profile',
    description: 'Keep agent logins between chats, in every project.',
    keywords: ['browser', 'profile', 'cookies', 'login', 'sign in', 'incognito', 'logged out'],
    anchorId: BROWSER_ANCHORS.appProfile
  },
  {
    categoryId: 'browser',
    label: 'Ask before opening new sites',
    description: 'Off: agents open public sites and devices on your local network without asking.',
    keywords: [
      'browser',
      'site',
      'website',
      'open',
      'navigate',
      'prompt',
      'ask',
      'allow',
      'local network',
      'lan',
      'device',
      'automation'
    ],
    anchorId: BROWSER_ANCHORS.appSitePrompt
  },
  {
    categoryId: 'browser',
    label: 'Ask before an agent submits a password',
    description: 'Have agents ask you before they sign in to a site.',
    keywords: ['browser', 'password', 'sign in', 'login', 'prompt', 'ask', 'automation'],
    anchorId: BROWSER_ANCHORS.appPasswordPrompt
  },
  {
    categoryId: 'browser',
    label: 'Clear agent profile',
    description: 'Delete the shared agent profile logins and site data.',
    keywords: ['browser', 'cookies', 'sign out', 'logins', 'wipe', 'reset'],
    anchorId: BROWSER_ANCHORS.appClear
  },
  {
    categoryId: 'browser',
    label: 'Pre-approved actions in every project',
    description: 'Actions agents may take on the shared agent profile without asking.',
    keywords: ['browser', 'upload', 'download', 'approve', 'automation'],
    anchorId: BROWSER_ANCHORS.appPreapprovals
  },
  // App
  {
    categoryId: 'shortcuts',
    label: 'Keyboard shortcuts',
    description: 'Customize keyboard shortcuts to match your workflow.',
    keywords: ['hotkeys', 'bindings', 'keybindings']
  },
  {
    categoryId: 'about',
    label: 'Check for updates',
    description: 'Your Karsa version, and a check for a newer one.',
    keywords: ['version', 'upgrade', 'update', 'about'],
    anchorId: rowId('check-updates')
  },
  {
    categoryId: 'about',
    label: 'Release channel',
    description: 'Choose the Stable or Nightly update track.',
    keywords: ['nightly', 'stable', 'prerelease', 'beta', 'channel'],
    anchorId: rowId('release-channel')
  },
  {
    categoryId: 'about',
    label: 'Check for updates automatically',
    description: 'Automatically check for updates.',
    keywords: ['automatic', 'version', 'auto-update'],
    anchorId: rowId('auto-update')
  },
  {
    categoryId: 'about',
    label: 'Connect another device',
    description: 'Scan a QR code to open this Karsa server on a phone or tablet.',
    keywords: ['qr', 'qrcode', 'barcode', 'phone', 'mobile', 'tablet', 'scan', 'connect', 'link'],
    anchorId: rowId('server-qr')
  },
  {
    categoryId: 'about',
    label: 'Server',
    description: 'Address, port and update channel for this Karsa server.',
    keywords: ['server', 'address', 'port', 'host', 'bind', 'remote', 'restart'],
    anchorId: rowId('server-config')
  },
  {
    categoryId: 'about',
    label: 'Version',
    description: 'The current Karsa app version.',
    keywords: ['version', 'upgrade'],
    anchorId: rowId('server-version')
  },
  {
    categoryId: 'about',
    label: 'Logs',
    description: 'Export or copy application logs to troubleshoot issues.',
    keywords: ['logs', 'export', 'troubleshoot', 'debug', 'diagnostics'],
    anchorId: rowId('application-log')
  },
  {
    categoryId: 'about',
    label: 'Reset all settings',
    description: 'Restore all settings to their default values.',
    keywords: ['restore', 'defaults', 'clear'],
    anchorId: rowId('reset-settings')
  }
]

/** Search entries for the current runtime. */
export function appPrefSearchIndex(): SettingsSearchEntry[] {
  const hidden = isTauriContext() ? WEB_ONLY_ANCHORS : DESKTOP_ONLY_ANCHORS
  // The translucent sidebar row renders on macOS desktop only.
  const translucentHidden = !isTranslucentRailSupported()
  return APP_PREF_SEARCH_INDEX.filter((entry) => {
    if (entry.anchorId && hidden.has(entry.anchorId)) return false
    if (translucentHidden && entry.anchorId === rowId('translucent-rail')) return false
    return true
  })
}
