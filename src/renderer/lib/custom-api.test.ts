import { describe, expect, it } from 'vitest'
import {
  buildCustomApiAgentConfig,
  describeCustomApiConfig,
  formatHeadersText,
  isCustomApiAgentConfig,
  KARSA_API_COMMAND,
  parseCustomApiConfig,
  parseHeadersText
} from './custom-api'

describe('custom-api config helpers', () => {
  it('builds and round-trips a user-defined custom API connection without provider detection', () => {
    const cfg = buildCustomApiAgentConfig({
      name: 'My Proxy LLM',
      endpoint: 'https://llm.internal.example/v1',
      format: 'anthropic',
      models: ['claude-sonnet-4-5', 'claude-opus-4-5'],
      contextWindow: 200_000,
      customHeaders: { 'X-Team': 'platform', 'HTTP-Referer': 'https://karsa.local' },
      systemPrompt: 'Be concise.',
      allowTerminal: true
    })

    expect(cfg.command).toBe(KARSA_API_COMMAND)
    expect(isCustomApiAgentConfig(cfg)).toBe(true)
    expect(cfg.name).toBe('My Proxy LLM')
    expect(cfg.allowTerminal).toBe(true)

    const parsed = parseCustomApiConfig(cfg)
    expect(parsed.name).toBe('My Proxy LLM')
    expect(parsed.endpoint).toBe('https://llm.internal.example/v1')
    expect(parsed.format).toBe('anthropic')
    expect(parsed.models).toEqual(['claude-sonnet-4-5', 'claude-opus-4-5'])
    expect(parsed.contextWindow).toBe(200_000)
    expect(parsed.customHeaders).toEqual({
      'X-Team': 'platform',
      'HTTP-Referer': 'https://karsa.local'
    })
    expect(parsed.systemPrompt).toBe('Be concise.')
    expect(parsed.allowTerminal).toBe(true)

    const desc = describeCustomApiConfig(cfg)
    expect(desc).toContain('Anthropic Messages')
    expect(desc).toContain('https://llm.internal.example/v1')
    expect(desc).toContain('claude-sonnet-4-5')
  })

  it('parses and formats custom HTTP header lines with validation', () => {
    const ok = parseHeadersText('HTTP-Referer: https://app.test\nX-Title: Karsa\n')
    expect(ok.error).toBeNull()
    expect(ok.headers).toEqual({
      'HTTP-Referer': 'https://app.test',
      'X-Title': 'Karsa'
    })
    expect(formatHeadersText(ok.headers)).toBe('HTTP-Referer: https://app.test\nX-Title: Karsa')

    const bad = parseHeadersText('MissingColonLine')
    expect(bad.error).toContain('Line 1')
  })
})
