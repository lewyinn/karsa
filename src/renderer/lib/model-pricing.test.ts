import { describe, expect, it } from 'vitest'
import {
  estimateTokensCostUsd,
  FALLBACK_MODEL_PRICING,
  formatCompactTokens,
  formatUsd,
  parseOpenRouterPricingPayload,
  resolveModelPricing
} from './model-pricing'

describe('model-pricing', () => {
  it('parses OpenRouter models payload for anthropic and google models', () => {
    const map = parseOpenRouterPricingPayload({
      data: [
        {
          id: 'anthropic/claude-sonnet-4',
          pricing: { prompt: '0.000003', completion: '0.000015' }
        },
        {
          id: 'google/gemini-2.5-pro',
          pricing: { prompt: '0.00000125', completion: '0.00001' }
        },
        {
          id: 'other/free-model',
          pricing: { prompt: '0', completion: '0' }
        }
      ]
    })

    expect(map['anthropic/claude-sonnet-4']).toEqual({ prompt: 0.000003, completion: 0.000015 })
    expect(map['google/gemini-2.5-pro']).toEqual({ prompt: 0.00000125, completion: 0.00001 })
    expect(map['other/free-model']).toBeUndefined()
  })

  it('resolves dated Claude and Gemini model ids to accurate rates', () => {
    const claude = resolveModelPricing('claude-sonnet-4-20250514', FALLBACK_MODEL_PRICING)
    expect(claude.matchedKey).toBe('anthropic/claude-sonnet-4')

    const gemini = resolveModelPricing('gemini-2.5-flash', FALLBACK_MODEL_PRICING)
    expect(gemini.matchedKey).toBe('google/gemini-2.5-flash')
  })

  it('computes blended USD cost and formats tokens/currency cleanly', () => {
    // 100k tokens on Claude Sonnet 4: 80% * $3/M + 20% * $15/M = $0.24 + $0.30 = $0.54
    const cost = estimateTokensCostUsd('claude-sonnet-4', 100_000, FALLBACK_MODEL_PRICING)
    expect(cost).toBeCloseTo(0.54, 4)
    expect(formatCompactTokens(1_540_000)).toBe('1.54M')
    expect(formatCompactTokens(42_500)).toBe('42.5K')
    expect(formatUsd(0.54, true)).toBe('~$0.54')
  })
})
