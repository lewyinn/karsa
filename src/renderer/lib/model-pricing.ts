import { logFrontendError } from '@/lib/log-api'

export interface ModelTokenPricing {
  /** USD per 1 input token. */
  prompt: number
  /** USD per 1 output token. */
  completion: number
}

export interface ModelPricingSnapshot {
  source: 'live' | 'fallback'
  fetchedAt: number
  models: Record<string, ModelTokenPricing>
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_KEY = 'karsa:model-pricing:v1'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const FETCH_TIMEOUT_MS = 10_000

/** Coding sessions typically spend ~80% of tokens on context/input and ~20% on generated output. */
const INPUT_SHARE = 0.8
const OUTPUT_SHARE = 0.2

/** Built-in fallback pricing (USD per token) used while offline or before live fetch completes. */
export const FALLBACK_MODEL_PRICING: Record<string, ModelTokenPricing> = {
  'anthropic/claude-opus-4.5': { prompt: 5 / 1_000_000, completion: 25 / 1_000_000 },
  'anthropic/claude-opus-4': { prompt: 15 / 1_000_000, completion: 75 / 1_000_000 },
  'anthropic/claude-sonnet-4.5': { prompt: 3 / 1_000_000, completion: 15 / 1_000_000 },
  'anthropic/claude-sonnet-4': { prompt: 3 / 1_000_000, completion: 15 / 1_000_000 },
  'anthropic/claude-3.7-sonnet': { prompt: 3 / 1_000_000, completion: 15 / 1_000_000 },
  'anthropic/claude-3.5-sonnet': { prompt: 3 / 1_000_000, completion: 15 / 1_000_000 },
  'anthropic/claude-haiku-4.5': { prompt: 1 / 1_000_000, completion: 5 / 1_000_000 },
  'anthropic/claude-3.5-haiku': { prompt: 0.8 / 1_000_000, completion: 4 / 1_000_000 },
  'google/gemini-2.5-pro': { prompt: 1.25 / 1_000_000, completion: 10 / 1_000_000 },
  'google/gemini-2.5-flash': { prompt: 0.3 / 1_000_000, completion: 2.5 / 1_000_000 },
  'google/gemini-3-pro': { prompt: 2 / 1_000_000, completion: 12 / 1_000_000 },
  'google/gemini-3-flash': { prompt: 0.5 / 1_000_000, completion: 3 / 1_000_000 },
  'google/gemini-2.0-flash': { prompt: 0.1 / 1_000_000, completion: 0.4 / 1_000_000 }
}

const DEFAULT_FALLBACK_PRICE: ModelTokenPricing = {
  prompt: 3 / 1_000_000,
  completion: 15 / 1_000_000
}

export function fallbackPricingSnapshot(): ModelPricingSnapshot {
  return {
    source: 'fallback',
    fetchedAt: 0,
    models: { ...FALLBACK_MODEL_PRICING }
  }
}

export function readCachedPricing(): ModelPricingSnapshot | null {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ModelPricingSnapshot>
    if (
      parsed &&
      typeof parsed.fetchedAt === 'number' &&
      parsed.models &&
      typeof parsed.models === 'object'
    ) {
      return {
        source: parsed.source === 'live' ? 'live' : 'fallback',
        fetchedAt: parsed.fetchedAt,
        models: parsed.models
      }
    }
    return null
  } catch {
    return null
  }
}

function writeCachedPricing(snapshot: ModelPricingSnapshot): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot))
  } catch {
    // Ignore storage quota errors.
  }
}

interface OpenRouterModelEntry {
  id?: unknown
  pricing?: {
    prompt?: unknown
    completion?: unknown
  }
}

/** Parse OpenRouter's public `/api/v1/models` payload into a normalized pricing map. */
export function parseOpenRouterPricingPayload(payload: unknown): Record<string, ModelTokenPricing> {
  const models: Record<string, ModelTokenPricing> = { ...FALLBACK_MODEL_PRICING }
  if (!payload || typeof payload !== 'object') return models
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return models

  for (const item of data as OpenRouterModelEntry[]) {
    if (typeof item?.id !== 'string' || !item.pricing) continue
    const id = item.id.toLowerCase()
    if (!id.startsWith('anthropic/') && !id.startsWith('google/') && !id.startsWith('openai/')) {
      continue
    }
    const prompt = Number.parseFloat(String(item.pricing.prompt ?? ''))
    const completion = Number.parseFloat(String(item.pricing.completion ?? ''))
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
      continue
    }
    if (prompt === 0 && completion === 0) continue
    models[id] = { prompt, completion }
  }
  return models
}

/** Fetch live model token pricing from OpenRouter (cached 24h in localStorage). */
export async function fetchLiveModelPricing(force = false): Promise<ModelPricingSnapshot> {
  const cached = readCachedPricing()
  if (
    !force &&
    cached &&
    cached.source === 'live' &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS
  ) {
    return cached
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const json: unknown = await response.json()
    const models = parseOpenRouterPricingPayload(json)
    const snapshot: ModelPricingSnapshot = {
      source: 'live',
      fetchedAt: Date.now(),
      models
    }
    writeCachedPricing(snapshot)
    return snapshot
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: 'model-pricing',
      message: `Live pricing fetch failed, using cached/fallback pricing: ${String(err)}`
    })
    return cached ?? fallbackPricingSnapshot()
  } finally {
    clearTimeout(timer)
  }
}

function normalizeModelId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/:(?:free|beta|thinking|preview)$/i, '')
    .replace(/-\d{8}$/, '')
    .replace(/_/g, '-')
}

/** Match a session model ID (e.g. `claude-sonnet-4-20250514` or `gemini-2.5-pro`) to pricing. */
export function resolveModelPricing(
  modelId: string | null | undefined,
  models: Record<string, ModelTokenPricing>
): { matchedKey: string | null; pricing: ModelTokenPricing } {
  if (!modelId) return { matchedKey: null, pricing: DEFAULT_FALLBACK_PRICE }
  const normalized = normalizeModelId(modelId)
  if (!normalized) return { matchedKey: null, pricing: DEFAULT_FALLBACK_PRICE }

  // 1. Direct or provider-prefixed exact match
  const directCandidates = [
    normalized,
    `anthropic/${normalized}`,
    `google/${normalized}`,
    `openai/${normalized}`
  ]
  for (const key of directCandidates) {
    if (models[key]) return { matchedKey: key, pricing: models[key] }
  }

  // 2. Strip provider prefix from catalog keys and match by longest shared prefix/substring
  const bareTarget = normalized.includes('/')
    ? (normalized.split('/').pop() ?? normalized)
    : normalized
  let bestKey: string | null = null
  let bestScore = 0
  for (const key of Object.keys(models)) {
    const bareKey = key.includes('/') ? (key.split('/').pop() ?? key) : key
    if (bareKey === bareTarget) {
      return { matchedKey: key, pricing: models[key] }
    }
    if (bareTarget.startsWith(bareKey) || bareKey.startsWith(bareTarget)) {
      const score = Math.min(bareKey.length, bareTarget.length)
      if (score > bestScore) {
        bestScore = score
        bestKey = key
      }
    }
  }
  if (bestKey && bestScore >= 6) {
    return { matchedKey: bestKey, pricing: models[bestKey] }
  }

  // 3. Family heuristics for versioned or marketing names
  if (bareTarget.includes('opus')) {
    const key = models['anthropic/claude-opus-4.5']
      ? 'anthropic/claude-opus-4.5'
      : 'anthropic/claude-opus-4'
    if (models[key]) return { matchedKey: key, pricing: models[key] }
  }
  if (bareTarget.includes('haiku')) {
    const key = models['anthropic/claude-haiku-4.5']
      ? 'anthropic/claude-haiku-4.5'
      : 'anthropic/claude-3.5-haiku'
    if (models[key]) return { matchedKey: key, pricing: models[key] }
  }
  if (bareTarget.includes('sonnet') || bareTarget.includes('claude')) {
    const key = models['anthropic/claude-sonnet-4']
      ? 'anthropic/claude-sonnet-4'
      : 'anthropic/claude-3.5-sonnet'
    if (models[key]) return { matchedKey: key, pricing: models[key] }
  }
  if (bareTarget.includes('gemini') && bareTarget.includes('flash')) {
    const key = models['google/gemini-2.5-flash']
      ? 'google/gemini-2.5-flash'
      : 'google/gemini-2.0-flash'
    if (models[key]) return { matchedKey: key, pricing: models[key] }
  }
  if (bareTarget.includes('gemini')) {
    const key = models['google/gemini-2.5-pro'] ? 'google/gemini-2.5-pro' : 'google/gemini-3-pro'
    if (models[key]) return { matchedKey: key, pricing: models[key] }
  }

  return { matchedKey: null, pricing: DEFAULT_FALLBACK_PRICE }
}

/** Estimate USD cost for a coding session using live/fallback token pricing. */
export function estimateTokensCostUsd(
  modelId: string | null | undefined,
  tokensUsed: number,
  models: Record<string, ModelTokenPricing>
): number {
  if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) return 0
  const { pricing } = resolveModelPricing(modelId, models)
  const blendedRate = pricing.prompt * INPUT_SHARE + pricing.completion * OUTPUT_SHARE
  return tokensUsed * blendedRate
}

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(Math.round(tokens))
}

export function formatUsd(amount: number, estimated = false): string {
  if (!Number.isFinite(amount) || amount <= 0) return estimated ? '~$0.00' : '$0.00'
  const prefix = estimated ? '~$' : '$'
  if (amount < 0.01) return `${prefix}${amount.toFixed(4)}`
  return `${prefix}${amount.toFixed(2)}`
}
