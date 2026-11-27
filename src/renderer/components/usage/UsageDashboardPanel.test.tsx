import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FALLBACK_MODEL_PRICING } from '@/lib/model-pricing'
import { useUsageHistoryStore } from '@/stores/usage-history-store'
import { UsageDashboardPanel } from './UsageDashboardPanel'

vi.mock('@/lib/claude-accounts-api', () => ({
  claudeAccountsApi: {
    list: vi.fn(async () => ({
      accounts: [{ id: 'default', name: 'ridho@example.com', builtin: true, signedIn: true }],
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
      accounts: [{ id: 'default', name: 'ridho@gmail.com', builtin: true, signedIn: true }],
      defaultAccountId: 'default',
      autoSwitch: false
    })),
    usage: vi.fn(async () => [
      {
        accountId: 'default',
        status: 'ok',
        planType: 'Google AI Pro',
        windows: [
          {
            kind: 'model',
            label: 'Gemini Models · Five Hour Limit Remaining',
            modelId: 'gemini-5h',
            percent: 80,
            resetsAt: null
          }
        ],
        checkedAt: Date.now(),
        message: null
      }
    ]),
    checkUsage: vi.fn(async () => null)
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
  it('displays Limits (% left), Tokens, and Cost tabs with real breakdown', async () => {
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

    // Limits tab (default): shows % left (100 - 42 = 58% left for Claude, 100 - 80 = 20% left for Antigravity)
    await waitFor(() => expect(screen.getByText('58%')).toBeInTheDocument())
    expect(screen.getByText('20%')).toBeInTheDocument()
    expect(screen.getByText('Gemini · 5-hour')).toBeInTheDocument()

    // Switch to Tokens tab
    fireEvent.click(screen.getByRole('tab', { name: 'Tokens' }))
    expect(screen.getByTestId('usage-total-tokens')).toHaveTextContent('100.0K')
    expect(screen.getByTestId('usage-model-claude-sonnet-4')).toBeInTheDocument()

    // Switch breakdown to Project
    fireEvent.click(screen.getByRole('button', { name: 'project' }))
    expect(screen.getByTestId('usage-project-internity')).toBeInTheDocument()

    // Switch to Cost tab
    fireEvent.click(screen.getByRole('tab', { name: 'Cost' }))
    expect(screen.getByTestId('usage-total-cost')).toHaveTextContent('~$0.54')
  })
})
