import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FALLBACK_MODEL_PRICING } from '@/lib/model-pricing'
import { useUsageHistoryStore } from '@/stores/usage-history-store'
import { UsageDashboardPanel } from './UsageDashboardPanel'

vi.mock('@/lib/claude-accounts-api', () => ({
  claudeAccountsApi: {
    list: vi.fn(async () => ({
      accounts: [{ id: 'default', name: 'Personal', builtin: true, signedIn: true }],
      defaultAccountId: 'default',
      autoSwitch: false
    })),
    usage: vi.fn(async () => [
      {
        accountId: 'default',
        status: 'ok',
        subscriptionType: 'pro',
        windows: [
          {
            kind: 'session',
            group: 'session',
            scope: null,
            percent: 42,
            resetsAt: null,
            severity: 'normal'
          }
        ],
        checkedAt: Date.now(),
        message: null
      }
    ])
  }
}))

vi.mock('@/lib/antigravity-accounts-api', () => ({
  antigravityAccountsApi: {
    list: vi.fn(async () => ({
      accounts: [],
      defaultAccountId: null,
      autoSwitch: false
    })),
    usage: vi.fn(async () => [])
  }
}))

beforeEach(() => {
  useUsageHistoryStore.setState({
    sessions: {},
    pricing: { source: 'live', fetchedAt: Date.now(), models: FALLBACK_MODEL_PRICING },
    loadingPricing: false
  })
})

describe('UsageDashboardPanel', () => {
  it('displays live Claude quota, estimated cost KPI, and switches between Sessions and Projects tabs', async () => {
    const now = Date.now()
    useUsageHistoryStore.getState().recordSample({
      sessionId: 'sess-1',
      title: 'Implement Multi-Repo',
      projectId: 'p1',
      projectName: 'internity',
      agentName: 'Antigravity',
      modelId: 'claude-sonnet-4',
      tokensUsed: 100_000,
      contextSize: 200_000,
      now
    })

    render(<UsageDashboardPanel />)

    await waitFor(() => expect(screen.getByText('Claude · Personal')).toBeInTheDocument())
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByTestId('usage-total-tokens')).toHaveTextContent('100.0K')
    expect(screen.getByTestId('usage-total-cost')).toHaveTextContent('~$0.54')
    expect(screen.getByTestId('usage-session-sess-1')).toHaveTextContent('Implement Multi-Repo')

    fireEvent.click(screen.getByRole('button', { name: /Projects \(1\)/i }))
    expect(screen.getByTestId('usage-project-internity')).toBeInTheDocument()
  })
})
