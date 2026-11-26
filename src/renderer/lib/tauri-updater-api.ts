import type { IpcResult } from '@shared/types/ipc.types'
import {
  type DownloadProgress,
  type UpdateInfo,
  UpdaterErrorCodes,
  type UpdateState
} from '@shared/types/updater.types'
import { logFrontendError } from './log-api'

const LOG_SOURCE = 'tauri-updater-api'

function logUpdater(level: 'info' | 'warn' | 'error', message: string): void {
  void logFrontendError({ level, source: LOG_SOURCE, message: `[updater] ${message}` })
}

export type UpdateChannel = 'stable' | 'nightly'
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable'

const CHANNEL_MANIFEST_URLS: Record<UpdateChannel, string> = {
  stable: 'https://github.com/gnoviawan/troupe/releases/latest/download/latest-stable.json',
  nightly: 'https://github.com/gnoviawan/troupe/releases/download/nightly/nightly.json'
}

const CHANNEL_RELEASE_PAGE_URLS: Record<UpdateChannel, string> = {
  stable: 'https://github.com/gnoviawan/troupe/releases/latest',
  nightly: 'https://github.com/gnoviawan/troupe/releases/tag/nightly'
}

export function getChannelManifestUrl(channel: UpdateChannel): string {
  return CHANNEL_MANIFEST_URLS[channel]
}

export function getChannelReleasePageUrl(channel: UpdateChannel): string {
  return CHANNEL_RELEASE_PAGE_URLS[channel]
}

export function normalizeUpdateChannel(value: string | null | undefined): UpdateChannel {
  return value === 'nightly' ? 'nightly' : DEFAULT_UPDATE_CHANNEL
}

export type UpdateMode = 'tauri' | 'aur'
const UPDATE_MODE: UpdateMode = import.meta.env.VITE_TERMUL_UPDATE_MODE === 'aur' ? 'aur' : 'tauri'

export const AUR_UPDATE_COMMAND = 'yay -S karsa'

/** Auto-updater against upstream gnoviawan/troupe is permanently disabled in custom Karsa builds. */
export const APP_UPDATER_DISABLED = true

let autoUpdateEnabled = false
let lastCheckedAt: string | null = null

export interface DisabledUpdateHandle {
  version: string
  date?: string | null
  body?: string | null
}

export interface TauriUpdaterEventHandlers {
  onUpdateAvailable?: (update: DisabledUpdateHandle) => void
  onDownloadProgress?: (progress: DownloadProgress) => void
  onUpdateDownloaded?: (update: DisabledUpdateHandle) => void
  onError?: (error: string) => void
}

export function getUpdateMode(): UpdateMode {
  return UPDATE_MODE
}

export function isAurUpdateMode(): boolean {
  return UPDATE_MODE === 'aur'
}

interface ParsedSemver {
  core: number[]
  prerelease: string[]
}

function parseSemver(version: string): ParsedSemver {
  const dashIndex = version.indexOf('-')
  const coreStr = dashIndex === -1 ? version : version.slice(0, dashIndex)
  const preStr = dashIndex === -1 ? '' : version.slice(dashIndex + 1)
  const core = coreStr.split('.').map((part) => Number.parseInt(part, 10) || 0)
  while (core.length < 3) core.push(0)
  const prerelease = preStr ? preStr.split('.') : []
  return { core, prerelease }
}

function isNumericIdentifier(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value)
}

function comparePrerelease(a: string[], b: string[]): number {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const ai = a[index]
    const bi = b[index]
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    const aNum = isNumericIdentifier(ai)
    const bNum = isNumericIdentifier(bi)
    if (aNum && bNum) {
      const diff = Number.parseInt(ai, 10) - Number.parseInt(bi, 10)
      if (diff !== 0) return diff
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1
    } else if (ai < bi) {
      return -1
    } else if (ai > bi) {
      return 1
    }
  }
  return 0
}

export function normalizeVersion(version: string): string {
  const trimmed = version.trim().replace(/^v/i, '')
  return trimmed.split('+')[0] ?? trimmed
}

export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(normalizeVersion(a))
  const pb = parseSemver(normalizeVersion(b))

  for (let index = 0; index < 3; index += 1) {
    const diff = pa.core[index] - pb.core[index]
    if (diff !== 0) return diff
  }

  const aHasPre = pa.prerelease.length > 0
  const bHasPre = pb.prerelease.length > 0
  if (!aHasPre && bHasPre) return 1
  if (aHasPre && !bHasPre) return -1
  if (aHasPre && bHasPre) return comparePrerelease(pa.prerelease, pb.prerelease)
  return 0
}

export async function checkForUpdates(
  channel: UpdateChannel = DEFAULT_UPDATE_CHANNEL
): Promise<UpdateInfo | null> {
  logUpdater(
    'info',
    `auto-updates disabled in custom Karsa build; ignoring check (channel=${channel})`
  )
  return null
}

export async function downloadUpdate(
  _onProgress?: (progress: DownloadProgress) => void
): Promise<IpcResult<void>> {
  return {
    success: false,
    error: 'Automatic updates are disabled in custom Karsa builds',
    code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
  }
}

export async function installAndRestart(): Promise<IpcResult<void>> {
  return {
    success: false,
    error: 'Automatic updates are disabled in custom Karsa builds',
    code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
  }
}

export function isUpdateDownloaded(_version: string): boolean {
  return false
}

export async function getUpdaterState(): Promise<IpcResult<UpdateState>> {
  return {
    success: true,
    data: {
      updateAvailable: false,
      downloaded: false,
      version: null,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      error: null,
      lastChecked: lastCheckedAt,
      isManualUpdateMode: false
    }
  }
}

export async function setAutoUpdateEnabled(enabled: boolean): Promise<IpcResult<void>> {
  autoUpdateEnabled = enabled
  return { success: true, data: undefined }
}

export async function getAutoUpdateEnabled(): Promise<IpcResult<boolean>> {
  return { success: true, data: autoUpdateEnabled }
}

export function registerUpdateEventHandlers(_handlers: TauriUpdaterEventHandlers): () => void {
  return () => {
    // Auto-updater disabled in custom Karsa builds.
  }
}

export async function clearPendingUpdate(): Promise<void> {}

export function _resetUpdaterStateForTesting(): void {
  lastCheckedAt = null
  autoUpdateEnabled = false
}

export function isInManualUpdateMode(): boolean {
  return false
}
