import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { tauriRef, stateRef, downloadUpdate, installAndRestart } = vi.hoisted(() => ({
  tauriRef: { current: true },
  stateRef: {
    current: {
      updateAvailable: false,
      version: null as string | null,
      downloaded: false,
      isDownloading: false,
      autoUpdateEnabled: true,
      isManualUpdateMode: false,
      error: null as string | null
    }
  },
  downloadUpdate: vi.fn(async () => {}),
  installAndRestart: vi.fn(async () => {})
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

vi.mock('@/stores/updater-store', () => ({
  useUpdaterState: () => stateRef.current,
  useUpdaterActions: () => ({ downloadUpdate, installAndRestart })
}))

import { RestartToUpdatePill } from './RestartToUpdatePill'

describe('RestartToUpdatePill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriRef.current = true
    stateRef.current = {
      updateAvailable: false,
      version: null,
      downloaded: false,
      isDownloading: false,
      autoUpdateEnabled: true,
      isManualUpdateMode: false,
      error: null
    }
  })

  it('auto-downloads silently in background when a signed update becomes available', async () => {
    stateRef.current = {
      ...stateRef.current,
      updateAvailable: true,
      version: '0.2.0',
      downloaded: false
    }
    const { container } = render(<RestartToUpdatePill />)
    expect(container).toBeEmptyDOMElement()
    await waitFor(() => expect(downloadUpdate).toHaveBeenCalledTimes(1))
  })

  it('shows Restart to Update pill once downloaded and triggers installAndRestart on click', async () => {
    stateRef.current = {
      ...stateRef.current,
      updateAvailable: true,
      version: '0.2.0',
      downloaded: true
    }
    render(<RestartToUpdatePill />)
    const button = screen.getByRole('button', { name: /Restart to Update/i })
    expect(button).toBeInTheDocument()
    expect(button).toHaveAttribute('title', 'Install Karsa v0.2.0 and restart')

    fireEvent.click(button)
    await waitFor(() => expect(installAndRestart).toHaveBeenCalledTimes(1))
  })

  it('renders nothing in browser/web mode', () => {
    tauriRef.current = false
    stateRef.current = {
      ...stateRef.current,
      updateAvailable: true,
      version: '0.2.0',
      downloaded: true
    }
    const { container } = render(<RestartToUpdatePill />)
    expect(container).toBeEmptyDOMElement()
  })
})
