/**
 * Add / Edit Custom API Connection dialog.
 *
 * Lets the user connect any third-party HTTP LLM API explicitly by specifying:
 * - their own connection name,
 * - the exact endpoint URL,
 * - an API key (stored in the OS keychain, never written to plaintext JSON),
 * - the explicit wire protocol (`openai`, `anthropic`, or `gemini` — never auto-detected),
 * - model IDs, optional context window, optional custom headers, and terminal access.
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Eye, EyeOff, KeyRound, Plug, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  buildCustomApiAgentConfig,
  CUSTOM_API_FORMAT_OPTIONS,
  type CustomApiFormat,
  customApi,
  formatHeadersText,
  parseCustomApiConfig,
  parseHeadersText
} from '@/lib/custom-api'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'

interface CustomApiDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, edits an existing `karsa-api` connection instead of creating a new one. */
  editing?: StoredAgentConfig | null
}

function parseModelsInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,\n]/)
        .map((m) => m.trim())
        .filter(Boolean)
    )
  )
}

export function CustomApiDialog({
  open,
  onOpenChange,
  editing = null
}: CustomApiDialogProps): React.JSX.Element {
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)

  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [format, setFormat] = useState<CustomApiFormat>('openai')
  const [apiKey, setApiKey] = useState('')
  const [hasSavedKey, setHasSavedKey] = useState(false)
  const [clearSavedKey, setClearSavedKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [modelsText, setModelsText] = useState('')
  const [contextWindow, setContextWindow] = useState('128000')
  const [headersText, setHeadersText] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [allowTerminal, setAllowTerminal] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setTestResult(null)
    setApiKey('')
    setClearSavedKey(false)
    setShowKey(false)

    if (editing) {
      const parsed = parseCustomApiConfig(editing)
      setName(parsed.name)
      setEndpoint(parsed.endpoint)
      setFormat(parsed.format)
      setModelsText(parsed.models.join(', '))
      setContextWindow(String(parsed.contextWindow))
      const hdrStr = formatHeadersText(parsed.customHeaders)
      setHeadersText(hdrStr)
      setSystemPrompt(parsed.systemPrompt)
      setAllowTerminal(parsed.allowTerminal)
      setShowAdvanced(Boolean(hdrStr || parsed.systemPrompt))

      const cid = editing.configId ?? editing.id
      void customApi
        .hasApiKey(cid)
        .then((present) => setHasSavedKey(present))
        .catch(() => setHasSavedKey(false))
    } else {
      setName('')
      setEndpoint('')
      setFormat('openai')
      setModelsText('')
      setContextWindow('128000')
      setHeadersText('')
      setSystemPrompt('')
      setAllowTerminal(false)
      setShowAdvanced(false)
      setHasSavedKey(false)
    }
  }, [open, editing])

  const selectedFormatMeta =
    CUSTOM_API_FORMAT_OPTIONS.find((opt) => opt.value === format) ?? CUSTOM_API_FORMAT_OPTIONS[0]

  const validateFields = (): {
    models: string[]
    ctx: number
    headers: Record<string, string>
  } | null => {
    if (!name.trim()) {
      setError('Connection name is required.')
      return null
    }
    const ep = endpoint.trim()
    if (!ep) {
      setError('Endpoint URL is required.')
      return null
    }
    try {
      const parsedUrl = new URL(ep)
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        setError('Endpoint URL must start with http:// or https://.')
        return null
      }
    } catch {
      setError('Enter a valid http:// or https:// endpoint URL.')
      return null
    }

    const models = parseModelsInput(modelsText)
    if (models.length === 0) {
      setError('Enter at least one model ID (comma-separated).')
      return null
    }

    const ctx = Number.parseInt(contextWindow.trim(), 10)
    if (!Number.isFinite(ctx) || ctx < 1024) {
      setError('Context window must be a number of at least 1024 tokens.')
      return null
    }

    const parsedHeaders = parseHeadersText(headersText)
    if (parsedHeaders.error) {
      setError(`Custom headers — ${parsedHeaders.error}`)
      return null
    }

    setError(null)
    return { models, ctx, headers: parsedHeaders.headers }
  }

  const handleTest = async (): Promise<void> => {
    const validated = validateFields()
    if (!validated) return

    setTesting(true)
    setTestResult(null)
    try {
      const result = await customApi.testConnection({
        configId: editing ? (editing.configId ?? editing.id) : undefined,
        endpoint: endpoint.trim(),
        format,
        model: validated.models[0],
        apiKey: apiKey.trim() || undefined,
        customHeaders: validated.headers
      })
      setTestResult({ ok: result.ok, message: result.message })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setTestResult({ ok: false, message })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    const validated = validateFields()
    if (!validated) return

    setSaving(true)
    try {
      const nextConfig = buildCustomApiAgentConfig(
        {
          name: name.trim(),
          endpoint: endpoint.trim(),
          format,
          models: validated.models,
          contextWindow: validated.ctx,
          customHeaders: validated.headers,
          systemPrompt: systemPrompt.trim(),
          allowTerminal
        },
        editing ?? undefined
      )

      const configId = nextConfig.configId ?? nextConfig.id
      const typedKey = apiKey.trim()
      if (typedKey.length > 0) {
        await customApi.saveApiKey(configId, typedKey)
      } else if (clearSavedKey && editing) {
        await customApi.deleteApiKey(configId)
      }

      await saveAgentConfig(nextConfig)
      void logFrontendError({
        level: 'info',
        source: 'CustomApiDialog',
        message: `${editing ? 'Updated' : 'Created'} custom API connection "${nextConfig.name}" (${format})`
      })
      toast.success(
        editing
          ? `Updated "${nextConfig.name}" API connection`
          : `Added "${nextConfig.name}" — ready to select in chat`
      )
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      void logFrontendError({
        level: 'error',
        source: 'CustomApiDialog',
        message: `Failed to save custom API connection: ${message}`
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Plug size={16} />
            {editing ? 'Edit API Connection' : 'Add API Connection'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Connect any third-party HTTP API directly using your own name, endpoint URL, API key,
            and model IDs. API keys are stored securely in your OS keychain.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="custom-api-name" className="text-xs">
              Name
            </Label>
            <Input
              id="custom-api-name"
              placeholder="e.g. My Anthropic, Google Dev API, OpenRouter, Local Ollama"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-api-format" className="text-xs">
              API Format
            </Label>
            <fieldset
              id="custom-api-format"
              aria-label="API Format"
              className="grid grid-cols-3 gap-1.5 border-0 p-0"
            >
              {CUSTOM_API_FORMAT_OPTIONS.map((opt) => {
                const active = format === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    disabled={saving}
                    onClick={() => {
                      setFormat(opt.value)
                      setTestResult(null)
                    }}
                    className={cn(
                      'rounded-md border px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </fieldset>
            <p className="text-2xs text-muted-foreground">{selectedFormatMeta.hint}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-api-endpoint" className="text-xs">
              Endpoint URL
            </Label>
            <Input
              id="custom-api-endpoint"
              type="url"
              placeholder={
                format === 'anthropic'
                  ? 'https://api.anthropic.com/v1/messages'
                  : format === 'gemini'
                    ? 'https://generativelanguage.googleapis.com/v1beta'
                    : 'https://api.openai.com/v1'
              }
              value={endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value)
                setTestResult(null)
              }}
              disabled={saving}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="custom-api-key" className="flex items-center gap-1.5 text-xs">
                <KeyRound size={12} />
                API Key
              </Label>
              {editing && hasSavedKey && !clearSavedKey && !apiKey && (
                <span className="flex items-center gap-1.5 text-2xs text-success">
                  Saved in OS keychain
                  <button
                    type="button"
                    className="text-muted-foreground underline hover:text-destructive"
                    onClick={() => setClearSavedKey(true)}
                  >
                    Clear
                  </button>
                </span>
              )}
              {clearSavedKey && !apiKey && (
                <span className="text-2xs text-warning">Key will be removed on save</span>
              )}
            </div>
            <div className="relative">
              <Input
                id="custom-api-key"
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                placeholder={
                  editing && hasSavedKey && !clearSavedKey
                    ? 'Leave blank to keep saved key'
                    : 'Paste API key (optional for local endpoints)'
                }
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  if (e.target.value) setClearSavedKey(false)
                  setTestResult(null)
                }}
                disabled={saving}
                className="pr-9 font-mono text-xs"
              />
              <button
                type="button"
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                onClick={() => setShowKey((prev) => !prev)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-api-models" className="text-xs">
              Models (comma-separated)
            </Label>
            <Input
              id="custom-api-models"
              placeholder={
                format === 'anthropic'
                  ? 'claude-sonnet-4-5, claude-opus-4-5'
                  : format === 'gemini'
                    ? 'gemini-2.5-pro, gemini-2.5-flash'
                    : 'gpt-4.1, gpt-4o-mini'
              }
              value={modelsText}
              onChange={(e) => {
                setModelsText(e.target.value)
                setTestResult(null)
              }}
              disabled={saving}
              className="font-mono text-xs"
            />
            <p className="text-2xs text-muted-foreground">
              The first model is selected by default; all listed models appear in the chat model
              picker.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="custom-api-ctx" className="text-xs">
                Context Window (tokens)
              </Label>
              <Input
                id="custom-api-ctx"
                type="number"
                min={1024}
                step={1024}
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                disabled={saving}
                className="font-mono text-xs"
              />
            </div>

            <div className="flex items-end pb-1">
              <label
                htmlFor="custom-api-terminal"
                className="flex cursor-pointer items-center gap-2 text-xs text-foreground select-none"
              >
                <Switch
                  id="custom-api-terminal"
                  checked={allowTerminal}
                  onCheckedChange={setAllowTerminal}
                  disabled={saving}
                />
                <span>Allow terminal commands</span>
              </label>
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {showAdvanced
                ? '▾ Hide advanced options'
                : '▸ Advanced (custom headers & system prompt)'}
            </button>

            {showAdvanced && (
              <div className="mt-2.5 space-y-3 rounded-md border border-border/70 bg-muted/20 p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="custom-api-headers" className="text-xs">
                    Custom HTTP Headers (one per line: Header: Value)
                  </Label>
                  <Textarea
                    id="custom-api-headers"
                    rows={2}
                    placeholder={'HTTP-Referer: https://your-app.com\nX-Title: Karsa'}
                    value={headersText}
                    onChange={(e) => setHeadersText(e.target.value)}
                    disabled={saving}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="custom-api-system" className="text-xs">
                    System Prompt Override (optional)
                  </Label>
                  <Textarea
                    id="custom-api-system"
                    rows={2}
                    placeholder="Optional custom instructions prepended to every chat"
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    disabled={saving}
                    className="text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          {testResult && (
            <div
              className={cn(
                'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
                testResult.ok
                  ? 'border-success/40 bg-success/10 text-success'
                  : 'border-destructive/40 bg-destructive/10 text-destructive'
              )}
            >
              {testResult.ok ? (
                <Check size={14} className="mt-0.5 shrink-0" />
              ) : (
                <X size={14} className="mt-0.5 shrink-0" />
              )}
              <span className="break-words">{testResult.message}</span>
            </div>
          )}

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={testing || saving}
            onClick={() => void handleTest()}
          >
            {testing ? <Spinner size={12} decorative /> : <Plug size={13} />}
            {testing ? 'Testing…' : 'Test Connection'}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? <Spinner size={12} decorative /> : null}
              {editing ? 'Save Changes' : 'Add Connection'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
