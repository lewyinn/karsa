import {
  Bookmark,
  Bot,
  GitBranch,
  Globe,
  Info,
  Keyboard,
  KeyRound,
  Network,
  Sliders,
  Sparkles,
  Terminal
} from '@/components/icons'
import type { SettingsCategory } from '@/components/settings/SettingsLayout'
import { isTauriContext } from '@/lib/tauri-runtime'

export { appPrefSearchIndex } from './search-index'

const RAIL_ICON_SIZE = 14

/**
 * The Settings pages, in rail order. Preferences has no group, so the rail
 * shows it above the first group label.
 */
const APP_PREF_CATEGORIES: SettingsCategory[] = [
  {
    id: 'preferences',
    label: 'Preferences',
    description: 'How Karsa looks, when it notifies you, where links open and how files save.',
    icon: <Sliders size={RAIL_ICON_SIZE} />
  },
  {
    id: 'terminal',
    group: 'Terminal',
    label: 'Terminal',
    description: 'How terminals draw text, and what new terminals start with.',
    icon: <Terminal size={RAIL_ICON_SIZE} />
  },
  {
    id: 'terminal-profiles',
    group: 'Terminal',
    label: 'Profiles',
    description:
      'Saved terminals with their own shell, arguments, folder and variables. Open one from the command palette.',
    icon: <Bookmark size={RAIL_ICON_SIZE} />
  },
  {
    id: 'provider',
    group: 'Agents',
    label: 'Accounts',
    description: 'The accounts that agent chats use, and how much of each limit is used.',
    icon: <KeyRound size={RAIL_ICON_SIZE} />
  },
  {
    id: 'ai-agents',
    group: 'Agents',
    label: 'Agents',
    description: 'The agents Karsa can start, and how long their chats may run.',
    icon: <Bot size={RAIL_ICON_SIZE} />
  },
  {
    id: 'subagents',
    group: 'Agents',
    label: 'Sub-agents',
    description: 'Agents your chats can hand work to, and what each one runs with.',
    icon: <GitBranch size={RAIL_ICON_SIZE} />
  },
  {
    id: 'skills',
    group: 'Agents',
    label: 'Skills',
    description:
      'Skills in your home folder and in the open project. The slash menu uses this list.',
    icon: <Sparkles size={RAIL_ICON_SIZE} />
  },
  {
    id: 'mcp-servers',
    group: 'Agents',
    label: 'MCP servers',
    description:
      'Servers that new agent chats can use. Each enabled server is offered when a chat starts.',
    icon: <Network size={RAIL_ICON_SIZE} />
  },
  {
    id: 'browser',
    group: 'Agents',
    label: 'Browser',
    description:
      'Which sites agents may browse without asking, and whether they keep logins between chats.',
    icon: <Globe size={RAIL_ICON_SIZE} />
  },
  {
    id: 'shortcuts',
    group: 'App',
    label: 'Keyboard shortcuts',
    description: 'Select a shortcut, then press the new keys. Esc cancels.',
    icon: <Keyboard size={RAIL_ICON_SIZE} />
  },
  {
    id: 'about',
    group: 'App',
    label: 'About',
    description: 'Your version, application logs, and a full reset.',
    icon: <Info size={RAIL_ICON_SIZE} />
  }
]

// The web client updates with its server (issue #843) and can reconfigure
// that server (gh-1105), so About describes a different set of parts there.
const WEB_ABOUT_DESCRIPTION = 'This Karsa version, application logs, and a full reset.'

/** Pages for the current runtime. */
export function appPrefCategories(): SettingsCategory[] {
  if (isTauriContext()) return APP_PREF_CATEGORIES
  return APP_PREF_CATEGORIES.map((category) =>
    category.id === 'about' ? { ...category, description: WEB_ABOUT_DESCRIPTION } : category
  )
}
