import { tauriUnavailable } from './unavailable'

export class Update {
  version = ''
  date?: string
  body?: string
  async download(): Promise<never> {
    throw tauriUnavailable('@tauri-apps/plugin-updater:Update.download')
  }
  async install(): Promise<never> {
    throw tauriUnavailable('@tauri-apps/plugin-updater:Update.install')
  }
  async close(): Promise<void> {}
}

export async function check(): Promise<Update | null> {
  return null
}
