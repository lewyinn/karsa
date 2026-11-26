import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRunStackStore } from '@/stores/run-stack-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { RunStackPanel } from './RunStackPanel'

const mocks = vi.hoisted(() => ({
  discoverStackServices: vi.fn(),
  startService: vi.fn(),
  stopService: vi.fn(),
  startAll: vi.fn(),
  fixServiceInChat: vi.fn()
}))

vi.mock('@/lib/stack-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stack-discovery')>()
  return {
    ...actual,
    discoverStackServices: mocks.discoverStackServices
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  useTerminalStore.setState({ terminals: [] })
  useRunStackStore.setState({
    discoveredByProject: {},
    persistedByProject: {},
    loadingByProject: {},
    terminalByServiceKey: {}
  })
})

describe('RunStackPanel', () => {
  it('lists discovered frontend/backend services and triggers Run all and Fix in Chat', async () => {
    const services = [
      {
        id: 'auto:/work/internity/frontend',
        name: 'frontend',
        cwd: '/work/internity/frontend',
        relativePath: 'frontend',
        command: 'bun run dev',
        runtimeLabel: 'Vite'
      },
      {
        id: 'auto:/work/internity/backend',
        name: 'backend',
        cwd: '/work/internity/backend',
        relativePath: 'backend',
        command: 'npm run dev',
        runtimeLabel: 'Node API'
      }
    ]
    mocks.discoverStackServices.mockResolvedValue(services)
    const startAllSpy = vi.spyOn(useRunStackStore.getState(), 'startAll').mockResolvedValue()
    const fixSpy = vi.spyOn(useRunStackStore.getState(), 'fixServiceInChat').mockResolvedValue()

    useTerminalStore.setState({
      terminals: [
        {
          id: 'term-be',
          name: 'Stack: backend',
          projectId: 'p1',
          shell: 'powershell',
          cwd: '/work/internity/backend',
          ptyId: 'pty-be',
          lastExitCode: 1
        } as never
      ]
    })
    useRunStackStore.setState({
      terminalByServiceKey: { 'p1::auto:/work/internity/backend': 'term-be' }
    })

    render(<RunStackPanel projectId="p1" projectRoot="/work/internity" repos={[]} />)

    await waitFor(() => expect(screen.getByTestId('stack-service-frontend')).toBeInTheDocument())
    expect(screen.getByTestId('stack-service-backend')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /run all/i }))
    expect(startAllSpy).toHaveBeenCalledWith('p1', services)

    fireEvent.click(screen.getByRole('button', { name: /fix in chat/i }))
    expect(fixSpy).toHaveBeenCalledWith('p1', services[1])
  })
})
