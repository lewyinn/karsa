import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

import { AgentProse } from './chat-agent-prose'

describe('AgentProse file links with spaces in the path', () => {
  it('renders [label](file:///D:/Code Programming/x.php) as a link, not raw text', () => {
    const { container } = render(
      <AgentProse
        text={
          'Lihat [ `AuthServiceInterface` ](file:///D:/Code Programming/IoT-Platform/backend/app/Auth.php), lalu lanjut.'
        }
        streaming={false}
        reduced
      />
    )
    expect(container.textContent).not.toContain('](file:')
    expect(container.textContent).not.toContain('file:///D:/Code')
    expect(container.textContent).toContain('AuthServiceInterface')
  })
})
