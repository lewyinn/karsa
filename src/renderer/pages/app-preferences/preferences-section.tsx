import { ColorSwatchGroup } from '@/components/settings/ColorSwatchGroup'
import { rowId } from '@/components/settings/row-id'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsRow, settingsDescriptionId } from '@/components/settings/SettingsRow'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { SettingsStepper } from '@/components/settings/SettingsStepper'
import { SettingsSwitchRow } from '@/components/settings/SettingsSwitchRow'
import { Button } from '@/components/ui/button'
import { useUpdateAppSetting } from '@/hooks/use-app-settings'
import { isTranslucentRailSupported } from '@/hooks/use-translucent-rail'
import { canOpenInTroupeBrowser } from '@/lib/browser/open-in-troupe-browser'
import { scheduleAllDirtyAutoSaves } from '@/lib/editor-auto-save'
import { logFrontendError } from '@/lib/log-api'
import { isMac } from '@/lib/platform'
import { isTauriContext } from '@/lib/tauri-runtime'
import { getColorThemeDefinition, getEffectiveThemeId } from '@/lib/themes'
import {
  useAppearanceMode,
  useAppSettingsStore,
  useColorTheme,
  useDefaultProjectColor,
  useEditorAutoSave,
  useEditorAutoSaveDelayMs,
  useLinkOpenMode,
  useNotifyOnAgentChatNeedsYou,
  useNotifyOnAgentChatTurnFinished,
  useNotifyOnTerminalIdle,
  useTranslucentRail,
  useUiZoomLevel
} from '@/stores/app-settings-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { useThemePickerStore } from '@/stores/theme-picker-store'
import type { ProjectColor } from '@/types/project'
import {
  DEFAULT_APP_SETTINGS,
  EDITOR_AUTO_SAVE_DELAY_OPTIONS,
  LINK_OPEN_MODE_OPTIONS,
  type LinkOpenMode,
  UI_ZOOM_DEFAULT,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  UI_ZOOM_STEP
} from '@/types/settings'

/** Auto save is one choice: off, or on after one of the delays. */
const AUTO_SAVE_OFF = 'off'
const AUTO_SAVE_OPTIONS = [
  { value: AUTO_SAVE_OFF, label: 'Off' },
  ...EDITOR_AUTO_SAVE_DELAY_OPTIONS.map((option) => ({
    value: String(option.value),
    label: `After ${option.label}`
  }))
]

const isLinkOpenMode = (value: string): value is LinkOpenMode =>
  LINK_OPEN_MODE_OPTIONS.some((option) => option.value === value)

/**
 * The Preferences page: how Karsa looks, when it notifies you, where links
 * open, how files save, and what new projects start with.
 */
export function PreferencesSection(): React.JSX.Element {
  return (
    <SettingsSection id="preferences">
      <AppearanceGroup />
      <NotificationsGroup />
      {canOpenInTroupeBrowser() && <LinksGroup />}
      <EditorGroup />
      <NewProjectsGroup />
    </SettingsSection>
  )
}

function AppearanceGroup(): React.JSX.Element {
  const updateSetting = useUpdateAppSetting()
  const uiZoomLevel = useUiZoomLevel()
  const translucentRail = useTranslucentRail()
  const colorTheme = useColorTheme()
  const appearanceMode = useAppearanceMode()
  const themeName = getColorThemeDefinition(getEffectiveThemeId(colorTheme, appearanceMode)).name
  // Web (#858): Ctrl+=/-/0 are the browser zoom keys; the web defaults use Alt.
  const zoomKeys = isTauriContext() ? 'Ctrl+=, Ctrl+- and Ctrl+0' : 'Alt+=, Alt+- and Alt+0'

  const openThemePicker = (): void => {
    // The picker previews on the whole app, so Settings gets out of the way.
    const { colorTheme: family, appearanceMode: mode } = useAppSettingsStore.getState().settings
    useSettingsModalStore.getState().close()
    useThemePickerStore.getState().open(getEffectiveThemeId(family, mode))
  }

  const handleTranslucentRailToggle = async (enabled: boolean): Promise<void> => {
    await updateSetting('translucentRail', enabled)
    void logFrontendError({
      level: 'info',
      source: 'AppPreferences.translucentRail',
      message: `Translucent sidebar ${enabled ? 'enabled' : 'disabled'}`
    })
  }

  return (
    <SettingsGroup title="Appearance">
      <SettingsCard>
        <SettingsRow
          id={rowId('color-theme')}
          label="Theme"
          description={themeName}
          layout="inline"
        >
          <Button type="button" variant="secondary" size="xs" onClick={openThemePicker}>
            Change theme
          </Button>
        </SettingsRow>
        <SettingsRow
          id={rowId('ui-zoom')}
          label="Interface zoom"
          describes="ui-zoom"
          description={`Make everything larger or smaller, from 50% to 300%. ${zoomKeys} also work.`}
        >
          <SettingsStepper
            role="group"
            aria-label="Interface zoom"
            aria-describedby={settingsDescriptionId('ui-zoom')}
            value={uiZoomLevel}
            min={UI_ZOOM_MIN}
            max={UI_ZOOM_MAX}
            step={UI_ZOOM_STEP}
            onValueChange={(value) => updateSetting('uiZoomLevel', value)}
            format={(value) => `${Math.round(value * 100)}%`}
            decrementLabel="Decrease interface zoom"
            incrementLabel="Increase interface zoom"
            resetValue={UI_ZOOM_DEFAULT}
            resetLabel="Reset to 100%"
          />
        </SettingsRow>
        {isTranslucentRailSupported() && (
          <SettingsSwitchRow
            id="translucent-rail"
            label="Translucent sidebar"
            description="Show the desktop through the project sidebar, like Finder. Chats, terminals and editors stay solid."
            checked={translucentRail}
            onToggle={handleTranslucentRailToggle}
          />
        )}
      </SettingsCard>
    </SettingsGroup>
  )
}

function NotificationsGroup(): React.JSX.Element {
  const updateSetting = useUpdateAppSetting()
  const notifyOnTerminalIdle = useNotifyOnTerminalIdle()
  const notifyOnAgentChatTurnFinished = useNotifyOnAgentChatTurnFinished()
  const notifyOnAgentChatNeedsYou = useNotifyOnAgentChatNeedsYou()
  return (
    <SettingsGroup title="Notifications">
      <SettingsCard>
        <SettingsSwitchRow
          id="notify-needs-you"
          label="Notify when an agent chat needs you"
          description="An agent waits for your approval or an answer."
          checked={notifyOnAgentChatNeedsYou}
          onToggle={(enabled) => updateSetting('notifyOnAgentChatNeedsYou', enabled)}
        />
        <SettingsSwitchRow
          id="notify-turn-finished"
          label="Notify when an agent chat turn finishes"
          description="A chat turn ends and nothing is queued."
          checked={notifyOnAgentChatTurnFinished}
          onToggle={(enabled) => updateSetting('notifyOnAgentChatTurnFinished', enabled)}
        />
        <SettingsSwitchRow
          id="notify-terminal-idle"
          label="Notify when a terminal agent finishes"
          description="A long-running terminal tab goes quiet."
          checked={notifyOnTerminalIdle}
          onToggle={(enabled) => updateSetting('notifyOnTerminalIdle', enabled)}
        />
      </SettingsCard>
    </SettingsGroup>
  )
}

function LinksGroup(): React.JSX.Element {
  const updateSetting = useUpdateAppSetting()
  const linkOpenMode = useLinkOpenMode()
  const clickKey = isMac ? '⌘' : 'Ctrl'
  return (
    <SettingsGroup title="Links">
      <SettingsCard>
        <SettingsRow
          id={rowId('link-open-mode')}
          htmlFor="link-open-mode"
          label="Open links in"
          description={`For links in chats, terminals, Markdown and files. In a terminal, ${clickKey}‑click a link.`}
        >
          <SettingsSelect
            id="link-open-mode"
            aria-describedby={settingsDescriptionId('link-open-mode')}
            options={LINK_OPEN_MODE_OPTIONS}
            value={linkOpenMode}
            onValueChange={(value) => {
              if (isLinkOpenMode(value)) void updateSetting('linkOpenMode', value)
            }}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsGroup>
  )
}

function EditorGroup(): React.JSX.Element {
  const updateSetting = useUpdateAppSetting()
  const editorAutoSave = useEditorAutoSave()
  const editorAutoSaveDelayMs = useEditorAutoSaveDelayMs()
  const delay = EDITOR_AUTO_SAVE_DELAY_OPTIONS.some(
    (option) => option.value === editorAutoSaveDelayMs
  )
    ? editorAutoSaveDelayMs
    : DEFAULT_APP_SETTINGS.editorAutoSaveDelayMs

  const handleChange = async (value: string): Promise<void> => {
    if (value === AUTO_SAVE_OFF) {
      await updateSetting('editorAutoSave', false)
      return
    }
    await updateSetting('editorAutoSaveDelayMs', Number.parseInt(value, 10))
    if (!editorAutoSave) {
      await updateSetting('editorAutoSave', true)
      // Cover buffers that were already dirty when auto save was turned on.
      scheduleAllDirtyAutoSaves()
    }
  }

  return (
    <SettingsGroup title="Editor">
      <SettingsCard>
        <SettingsRow
          id={rowId('editor-auto-save')}
          htmlFor="editor-auto-save"
          label="Auto save"
          description="Save files after you stop typing. Files with changes save as soon as you turn it on."
        >
          <SettingsSelect
            id="editor-auto-save"
            aria-describedby={settingsDescriptionId('editor-auto-save')}
            options={AUTO_SAVE_OPTIONS}
            value={editorAutoSave ? String(delay) : AUTO_SAVE_OFF}
            onValueChange={(value) => void handleChange(value)}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsGroup>
  )
}

function NewProjectsGroup(): React.JSX.Element {
  const updateSetting = useUpdateAppSetting()
  const defaultProjectColor = useDefaultProjectColor() as ProjectColor
  return (
    <SettingsGroup title="New projects">
      <SettingsCard>
        <SettingsRow
          id={rowId('default-project-color')}
          label="Default color"
          description="New projects start with this color. You can change it per project."
        >
          <ColorSwatchGroup
            aria-label="Default project color"
            value={defaultProjectColor}
            onValueChange={(value) => updateSetting('defaultProjectColor', value)}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsGroup>
  )
}
