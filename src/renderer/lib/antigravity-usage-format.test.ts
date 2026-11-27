import type { AntigravityAccountUsage } from '@shared/types/antigravity-accounts.types'
import { describe, expect, it } from 'vitest'
import {
  antigravityChipUsage,
  antigravityResetSeconds,
  antigravityWindowLabel,
  primaryAntigravityWindow
} from './antigravity-usage-format'

const usage = (windows: AntigravityAccountUsage['windows']): AntigravityAccountUsage => ({
  accountId: 'default',
  status: 'ok',
  planType: 'Google AI Pro',
  windows,
  checkedAt: 1,
  message: null
})

const model = (
  modelId: string,
  percent: number,
  resetsAt: string | null = null,
  label = ''
): AntigravityAccountUsage['windows'][number] => ({
  kind: 'model',
  label,
  modelId,
  percent,
  resetsAt
})

describe('antigravity usage format', () => {
  it('names a window after its model, else its id, stripping misleading Remaining suffixes', () => {
    expect(antigravityWindowLabel(model('gemini-3-pro', 1, null, 'Gemini 3 Pro'))).toBe(
      'Gemini 3 Pro'
    )
    expect(antigravityWindowLabel(model('gemini-3-flash', 1))).toBe('gemini-3-flash')
    expect(
      antigravityWindowLabel(model('weekly', 0, null, 'Gemini Models · Weekly Limit Remaining'))
    ).toBe('Gemini Models · Weekly Limit')
  })

  it('picks the most used model', () => {
    const read = usage([model('flash', 40, null, 'Flash'), model('pro', 91, null, 'Pro')])
    expect(primaryAntigravityWindow(read)?.modelId).toBe('pro')
    expect(antigravityChipUsage(read)?.main).toMatchObject({ short: 'Pro', percent: 91 })
    expect(antigravityChipUsage(read)?.other).toBeNull()
  })

  it('skips a model whose quota has already reset', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const read = usage([model('pro', 100, past), model('flash', 80, future)])
    expect(primaryAntigravityWindow(read)?.modelId).toBe('flash')
    expect(antigravityResetSeconds(read.windows[1])).toBe(Math.floor(Date.parse(future) / 1000))
  })

  it('has no window when the read is not ok or empty', () => {
    expect(primaryAntigravityWindow({ ...usage([]), status: 'signed_out' })).toBeNull()
    expect(antigravityChipUsage(usage([]))).toBeNull()
  })
})
