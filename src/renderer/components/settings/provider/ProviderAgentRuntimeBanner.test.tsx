import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { ProviderAgentRuntimeBanner, useProviderAgentRuntime } from './ProviderAgentRuntimeBanner'

const mocks = vi.hoisted(() => ({
  entries: [] as SupportedAcpAgentEntry[],
  recheck: vi.fn(),
  install: vi.fn(),
  log: vi.fn()
}))

vi.mock('@/hooks/use-resolved-supported-acp-agents', () => ({
  useSupportedAcpAgentCatalog: () => ({
    entries: mocks.entries,
    checking: false,
    recheck: mocks.recheck
  })
}))
vi.mock('@/lib/agents/agent-setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/agent-setup')>()),
  installSupportedAgent: mocks.install
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.log }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function Harness({ canManage = true }: { canManage?: boolean }): React.JSX.Element {
  const runtime = useProviderAgentRuntime('antigravity-acp')
  return (
    <div>
      <div data-testid="badge">{runtime.badge}</div>
      <ProviderAgentRuntimeBanner runtime={runtime} canManage={canManage} />
    </div>
  )
}

function makeAntigravity(overrides: Partial<SupportedAcpAgentEntry> = {}): SupportedAcpAgentEntry {
  return {
    id: 'antigravity-acp',
    configId: 'acp-registry:antigravity-acp',
    agent: {
      id: 'antigravity-acp',
      name: 'Google Antigravity',
      version: '1.1.1',
      description: '',
      distribution: {}
    },
    config: null,
    status: 'install-required',
    install: {
      kind: 'archive',
      archiveUrl: 'https://example.invalid/agy.zip',
      cmd: './agy_acp_server.exe',
      args: [],
      env: {}
    },
    manualInstall: null,
    runtimeLauncher: null,
    unavailableReason: null,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.install.mockResolvedValue({ id: 'acp-registry:antigravity-acp' })
})

describe('ProviderAgentRuntimeBanner', () => {
  it('shows warning banner with Install button when Antigravity binary is not installed yet', async () => {
    const entry = makeAntigravity()
    mocks.entries = [entry]

    render(<Harness />)

    expect(screen.getByTestId('badge')).toHaveTextContent('Runtime not installed')
    expect(screen.getByTestId('provider-runtime-banner-antigravity-acp')).toHaveTextContent(
      'Google Antigravity runtime is not installed in Karsa yet.'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith(entry))
    await waitFor(() => expect(mocks.recheck).toHaveBeenCalledTimes(1))
  })

  it('shows Installed badge and hides banner once binary is ready locally', () => {
    mocks.entries = [
      makeAntigravity({
        status: 'ready',
        install: null,
        installedVersion: '1.1.1'
      })
    ]

    render(<Harness />)

    expect(screen.getByTestId('badge')).toHaveTextContent('Installed')
    expect(screen.queryByTestId('provider-runtime-banner-antigravity-acp')).not.toBeInTheDocument()
  })
})
