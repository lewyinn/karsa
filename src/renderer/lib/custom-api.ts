/**
 * Frontend facade & config helpers for Bring-Your-Own-API (3rd-party HTTP endpoint)
 * connections. Mirrors desktop Tauri commands and web `/api-connections/*` routes.
 *
 * API keys are NEVER persisted in `acp-agents.json` or logged — they live solely
 * in the host OS keychain (`karsa-api:<configId>`).
 */

import type { IpcResult } from '@shared/types/ipc.types'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { AgentConfig } from '@/lib/acp-api'
import { postJsonOnce } from '@/lib/ipc/http'
import { invokeIpcWrapped } from '@/lib/ipc/tauri'
import { isTauriContext } from '@/lib/tauri-runtime'
import { randomUUID } from '@/lib/uuid'

export const KARSA_API_COMMAND = 'karsa-api'

export const KARSA_API_ENV = {
  endpoint: 'KARSA_API_ENDPOINT',
  format: 'KARSA_API_FORMAT',
  models: 'KARSA_API_MODELS',
  contextWindow: 'KARSA_API_CONTEXT_WINDOW',
  headersJson: 'KARSA_API_HEADERS_JSON',
  systemPrompt: 'KARSA_API_SYSTEM_PROMPT'
} as const

export type CustomApiFormat = 'openai' | 'anthropic' | 'gemini'

export const CUSTOM_API_FORMAT_OPTIONS: ReadonlyArray<{
  value: CustomApiFormat
  label: string
  hint: string
}> = [
  {
    value: 'openai',
    label: 'OpenAI Compatible',
    hint: 'Bearer token · /chat/completions (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, LiteLLM, proxies)'
  },
  {
    value: 'anthropic',
    label: 'Anthropic Messages',
    hint: 'x-api-key · /v1/messages (Anthropic API & compatible endpoints)'
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    hint: 'x-goog-api-key · /models/{model}:streamGenerateContent (Google AI Studio / Gemini Dev API)'
  }
]

export interface CustomApiFormValues {
  name: string
  endpoint: string
  format: CustomApiFormat
  models: string[]
  contextWindow: number
  customHeaders: Record<string, string>
  systemPrompt: string
  allowTerminal: boolean
}

export interface TestCustomApiRequest {
  configId?: string
  endpoint: string
  format: CustomApiFormat
  model: string
  apiKey?: string
  customHeaders: Record<string, string>
}

export interface TestCustomApiResponse {
  ok: boolean
  message: string
  latencyMs: number
}

export function isCustomApiAgentConfig(
  cfg: Pick<AgentConfig, 'command'> | null | undefined
): boolean {
  return cfg?.command === KARSA_API_COMMAND
}

export function formatApiProtocolLabel(format: string | undefined): string {
  switch (format) {
    case 'anthropic':
      return 'Anthropic Messages'
    case 'gemini':
      return 'Google Gemini'
    default:
      return 'OpenAI Compatible'
  }
}

export function parseCustomApiConfig(cfg: StoredAgentConfig): CustomApiFormValues {
  const env = cfg.env ?? {}
  const rawFormat = (env[KARSA_API_ENV.format] ?? 'openai').toLowerCase()
  const format: CustomApiFormat =
    rawFormat === 'anthropic' || rawFormat === 'gemini' ? rawFormat : 'openai'

  const models = (env[KARSA_API_ENV.models] ?? '')
    .split(/[,\n]/)
    .map((m) => m.trim())
    .filter(Boolean)

  const parsedCtx = Number.parseInt(env[KARSA_API_ENV.contextWindow] ?? '128000', 10)
  const contextWindow = Number.isFinite(parsedCtx) && parsedCtx >= 1024 ? parsedCtx : 128000

  let customHeaders: Record<string, string> = {}
  if (env[KARSA_API_ENV.headersJson]) {
    try {
      const parsed = JSON.parse(env[KARSA_API_ENV.headersJson])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        customHeaders = Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      }
    } catch {
      customHeaders = {}
    }
  }

  return {
    name: cfg.name,
    endpoint: env[KARSA_API_ENV.endpoint] ?? '',
    format,
    models,
    contextWindow,
    customHeaders,
    systemPrompt: env[KARSA_API_ENV.systemPrompt] ?? '',
    allowTerminal: Boolean(cfg.allowTerminal)
  }
}

export function describeCustomApiConfig(cfg: StoredAgentConfig): string {
  const parsed = parseCustomApiConfig(cfg)
  const parts = [formatApiProtocolLabel(parsed.format)]
  if (parsed.endpoint) parts.push(parsed.endpoint)
  if (parsed.models.length > 0) {
    const shown = parsed.models.slice(0, 3).join(', ')
    const extra = parsed.models.length > 3 ? ` +${parsed.models.length - 3}` : ''
    parts.push(`${shown}${extra}`)
  }
  return parts.join(' · ')
}

export function buildCustomApiAgentConfig(
  values: CustomApiFormValues,
  existing?: StoredAgentConfig
): StoredAgentConfig {
  const id = existing?.id ?? `custom-api-${randomUUID().slice(0, 8)}`
  const configId = existing?.configId?.trim() || id

  const env: Record<string, string> = {
    [KARSA_API_ENV.endpoint]: values.endpoint.trim(),
    [KARSA_API_ENV.format]: values.format,
    [KARSA_API_ENV.models]: values.models.join(', '),
    [KARSA_API_ENV.contextWindow]: String(Math.max(1024, Math.round(values.contextWindow)))
  }

  const headerEntries = Object.entries(values.customHeaders)
    .map(([k, v]) => [k.trim(), v.trim()] as const)
    .filter(([k]) => k.length > 0)
  if (headerEntries.length > 0) {
    env[KARSA_API_ENV.headersJson] = JSON.stringify(Object.fromEntries(headerEntries))
  }

  const sysPrompt = values.systemPrompt.trim()
  if (sysPrompt.length > 0) {
    env[KARSA_API_ENV.systemPrompt] = sysPrompt
  }

  return {
    id,
    configId,
    name: values.name.trim(),
    command: KARSA_API_COMMAND,
    args: [],
    env,
    allowTerminal: values.allowTerminal,
    ...(existing?.icon ? { icon: existing.icon } : {})
  }
}

export function parseHeadersText(raw: string): {
  headers: Record<string, string>
  error: string | null
} {
  const headers: Record<string, string> = {}
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const sep = line.indexOf(':')
    if (sep <= 0) {
      return {
        headers: {},
        error: `Line ${i + 1}: expected "Header-Name: value"`
      }
    }
    const key = line.slice(0, sep).trim()
    const val = line.slice(sep + 1).trim()
    if (!key) {
      return {
        headers: {},
        error: `Line ${i + 1}: header name cannot be empty`
      }
    }
    headers[key] = val
  }
  return { headers, error: null }
}

export function formatHeadersText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

function unwrapResult<T>(res: IpcResult<T>): T {
  if (!res.success) {
    throw new Error(res.error ?? 'Request failed')
  }
  return res.data
}

export const customApi = {
  async saveApiKey(configId: string, apiKey: string): Promise<void> {
    if (isTauriContext()) {
      unwrapResult(await invokeIpcWrapped<void>('custom_api_save_key', { configId, apiKey }))
      return
    }
    unwrapResult(await postJsonOnce<void>('/api-connections/key', { configId, apiKey }))
  },

  async hasApiKey(configId: string): Promise<boolean> {
    if (isTauriContext()) {
      return unwrapResult(await invokeIpcWrapped<boolean>('custom_api_has_key', { configId }))
    }
    return unwrapResult(await postJsonOnce<boolean>('/api-connections/has-key', { configId }))
  },

  async deleteApiKey(configId: string): Promise<void> {
    if (isTauriContext()) {
      unwrapResult(await invokeIpcWrapped<void>('custom_api_delete_key', { configId }))
      return
    }
    unwrapResult(await postJsonOnce<void>('/api-connections/delete-key', { configId }))
  },

  async testConnection(request: TestCustomApiRequest): Promise<TestCustomApiResponse> {
    if (isTauriContext()) {
      return unwrapResult(
        await invokeIpcWrapped<TestCustomApiResponse>('custom_api_test', { request })
      )
    }
    return unwrapResult(await postJsonOnce<TestCustomApiResponse>('/api-connections/test', request))
  }
}
