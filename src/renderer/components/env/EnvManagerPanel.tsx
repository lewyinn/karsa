import type { DiscoveredGitRepo } from '@shared/types/ipc.types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  AlertTriangle,
  Check,
  Copy,
  Edit,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2
} from '@/components/icons'
import { SidePanelHeader } from '@/components/shell/SidePanelHeader'
import { Button } from '@/components/ui/button'
import { PANEL_FIELD_CLASS, QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { filesystemApi } from '@/lib/api'
import {
  buildSiblingDotEnvPath,
  type DiscoveredEnvFile,
  discoverEnvFiles,
  type EnvDocument,
  extractEnvEntries,
  findMissingEnvEntries,
  parseEnvDocument,
  serializeEnvDocument
} from '@/lib/env-file-manager'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'

interface EnvManagerPanelProps {
  projectRoot: string
  repos: readonly DiscoveredGitRepo[]
}

const VALID_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/

export function EnvManagerPanel({ projectRoot, repos }: EnvManagerPanelProps): React.JSX.Element {
  const [files, setFiles] = useState<DiscoveredEnvFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string>('')
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [saving, setSaving] = useState(false)
  const [doc, setDoc] = useState<EnvDocument | null>(null)
  const [missingEntries, setMissingEntries] = useState<Array<{ key: string; value: string }>>([])

  // Share-screen safety: all values start masked by default and re-mask on file switch.
  const [revealAll, setRevealAll] = useState(false)
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [search, setSearch] = useState('')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; key: string } | null>(null)

  const refreshFiles = useCallback(async () => {
    if (!projectRoot) return
    setLoadingFiles(true)
    try {
      const found = await discoverEnvFiles(projectRoot, repos)
      setFiles(found)
      setSelectedPath((prev) =>
        prev && found.some((file) => file.path === prev) ? prev : (found[0]?.path ?? '')
      )
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'EnvManagerPanel',
        message: `Failed to scan env files: ${String(err)}`
      })
    } finally {
      setLoadingFiles(false)
    }
  }, [projectRoot, repos])

  useEffect(() => {
    void refreshFiles()
  }, [refreshFiles])

  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath]
  )

  const loadSelectedFile = useCallback(async (file: DiscoveredEnvFile | null) => {
    setRevealAll(false)
    setRevealedIds(new Set())
    setEditingId(null)
    if (!file) {
      setDoc(null)
      setMissingEntries([])
      return
    }
    setLoadingDoc(true)
    try {
      const res = await filesystemApi.readFile(file.path)
      if (!res.success || !res.data) {
        toast.error(`Failed to read ${file.label}`)
        setDoc(null)
        setMissingEntries([])
        return
      }
      const parsed = parseEnvDocument(res.data.content)
      setDoc(parsed)

      if (file.siblingExamplePath) {
        const exRes = await filesystemApi.readFile(file.siblingExamplePath).catch(() => null)
        if (exRes?.success && exRes.data) {
          const exampleDoc = parseEnvDocument(exRes.data.content)
          setMissingEntries(findMissingEnvEntries(parsed, exampleDoc))
        } else {
          setMissingEntries([])
        }
      } else {
        setMissingEntries([])
      }
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'EnvManagerPanel',
        message: `Failed to load ${file.label}: ${String(err)}`
      })
      toast.error(`Failed to read ${file.label}`)
    } finally {
      setLoadingDoc(false)
    }
  }, [])

  useEffect(() => {
    void loadSelectedFile(selectedFile)
  }, [selectedFile, loadSelectedFile])

  const persistDocument = async (nextDoc: EnvDocument, successMessage: string) => {
    if (!selectedFile) return
    setSaving(true)
    try {
      const serialized = serializeEnvDocument(nextDoc)
      const res = await filesystemApi.writeFile(selectedFile.path, serialized)
      if (!res.success) {
        toast.error(res.error || `Failed to save ${selectedFile.label}`)
        return
      }
      setDoc(nextDoc)
      toast.success(successMessage)
      if (selectedFile.siblingExamplePath) {
        const exRes = await filesystemApi
          .readFile(selectedFile.siblingExamplePath)
          .catch(() => null)
        if (exRes?.success && exRes.data) {
          setMissingEntries(findMissingEnvEntries(nextDoc, parseEnvDocument(exRes.data.content)))
        }
      }
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'EnvManagerPanel',
        message: `Failed to save ${selectedFile.label}: ${String(err)}`
      })
      toast.error(`Failed to save ${selectedFile.label}`)
    } finally {
      setSaving(false)
    }
  }

  const entries = useMemo(() => (doc ? extractEnvEntries(doc) : []), [doc])
  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((entry) => entry.key.toLowerCase().includes(q))
  }, [entries, search])

  const toggleRevealRow = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCopyValue = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`Copied ${key}`)
    } catch {
      toast.error(`Could not copy ${key}`)
    }
  }

  const handleSaveEdit = async (entryId: string, key: string) => {
    if (!doc) return
    const nextDoc: EnvDocument = {
      lines: doc.lines.map((line) =>
        line.kind === 'entry' && line.id === entryId ? { ...line, value: editValue } : line
      )
    }
    setEditingId(null)
    await persistDocument(nextDoc, `Updated ${key}`)
  }

  const handleAddVariable = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!doc) return
    const trimmedKey = newKey.trim()
    if (!VALID_KEY_PATTERN.test(trimmedKey)) {
      toast.error('Invalid variable name (use letters, numbers, and underscores)')
      return
    }
    const existing = entries.find((e) => e.key === trimmedKey)
    const nextDoc: EnvDocument = existing
      ? {
          lines: doc.lines.map((line) =>
            line.kind === 'entry' && line.id === existing.id ? { ...line, value: newValue } : line
          )
        }
      : {
          lines: [
            ...doc.lines,
            {
              kind: 'entry',
              id: `line-${Date.now()}-${trimmedKey}`,
              key: trimmedKey,
              value: newValue,
              hasExportPrefix: false
            }
          ]
        }
    setNewKey('')
    setNewValue('')
    setAdding(false)
    await persistDocument(nextDoc, existing ? `Updated ${trimmedKey}` : `Added ${trimmedKey}`)
  }

  const handleConfirmDelete = async () => {
    if (!doc || !deleteTarget) return
    const target = deleteTarget
    const nextDoc: EnvDocument = {
      lines: doc.lines.filter((line) => !(line.kind === 'entry' && line.id === target.id))
    }
    setDeleteTarget(null)
    await persistDocument(nextDoc, `Removed ${target.key}`)
  }

  const handleAddMissingKeys = async () => {
    if (!doc || missingEntries.length === 0) return
    const appended = missingEntries.map((item, idx) => ({
      kind: 'entry' as const,
      id: `missing-${Date.now()}-${idx}-${item.key}`,
      key: item.key,
      value: item.value,
      hasExportPrefix: false
    }))
    const nextDoc: EnvDocument = {
      lines: [...doc.lines, ...appended]
    }
    await persistDocument(nextDoc, `Added ${missingEntries.length} missing keys`)
  }

  const canCreateDotEnvFromExample = useMemo(() => {
    if (!selectedFile?.isExample) return false
    const targetPath = buildSiblingDotEnvPath(selectedFile)
    return !files.some((f) => f.path.toLowerCase() === targetPath.toLowerCase())
  }, [selectedFile, files])

  const handleCreateDotEnvFromExample = async () => {
    if (!selectedFile || !doc) return
    const targetPath = buildSiblingDotEnvPath(selectedFile)
    setSaving(true)
    try {
      const content = serializeEnvDocument(doc)
      const res = await filesystemApi.writeFile(targetPath, content)
      if (!res.success) {
        toast.error(res.error || 'Failed to create .env')
        return
      }
      toast.success(
        `Created ${selectedFile.scopeLabel === 'root' ? '.env' : `${selectedFile.scopeLabel}/.env`}`
      )
      await refreshFiles()
      setSelectedPath(targetPath)
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'EnvManagerPanel',
        message: `Failed to create .env from example: ${String(err)}`
      })
      toast.error('Failed to create .env file')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidePanelHeader title="Env Manager">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={revealAll ? 'Mask all values' : 'Reveal all values'}
            title={revealAll ? 'Mask all values (share-screen safe)' : 'Reveal all values'}
            onClick={() => setRevealAll((prev) => !prev)}
            className={cn(QUIET_ICON_BUTTON_CLASS, 'size-7')}
          >
            {revealAll ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            type="button"
            aria-label="Add environment variable"
            title="Add variable"
            disabled={!selectedFile || saving}
            onClick={() => setAdding((open) => !open)}
            className={cn(QUIET_ICON_BUTTON_CLASS, 'size-7')}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label="Rescan env files"
            title="Rescan .env files"
            onClick={() => void refreshFiles()}
            className={cn(QUIET_ICON_BUTTON_CLASS, 'size-7')}
          >
            <RefreshCw size={13} className={cn(loadingFiles && 'animate-spin')} />
          </button>
        </div>
      </SidePanelHeader>

      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5 text-3xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck size={12} className="text-diff-added-foreground" />
          {revealAll ? 'Values visible' : 'Masked for share-screen safety'}
        </span>
        <span className="font-mono">{entries.length} keys</span>
      </div>

      {files.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-border/60 px-3 py-2">
          {files.map((file) => {
            const active = file.path === selectedPath
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedPath(file.path)}
                className={cn(
                  'rounded px-2 py-0.5 font-mono text-3xs transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/70 text-secondary-foreground hover:bg-muted'
                )}
              >
                {file.label}
              </button>
            )
          })}
        </div>
      )}

      {canCreateDotEnvFromExample && selectedFile && (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
          <span className="text-2xs text-muted-foreground">No .env in this folder yet.</span>
          <Button
            type="button"
            size="xs"
            variant="default"
            disabled={saving}
            onClick={() => void handleCreateDotEnvFromExample()}
          >
            Create .env
          </Button>
        </div>
      )}

      {missingEntries.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-destructive/10 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-2xs text-foreground">
            <AlertTriangle size={12} className="shrink-0 text-destructive" />
            {missingEntries.length} {missingEntries.length === 1 ? 'key' : 'keys'} missing from
            example
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={saving}
            onClick={() => void handleAddMissingKeys()}
          >
            Add missing
          </Button>
        </div>
      )}

      {selectedFile && (
        <div className="border-b border-border/60 px-3 py-2">
          <input
            type="text"
            aria-label="Filter environment keys"
            placeholder="Filter keys..."
            className={cn(PANEL_FIELD_CLASS, 'h-7 w-full px-2 text-xs')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {adding && (
        <form
          onSubmit={(e) => void handleAddVariable(e)}
          className="space-y-1.5 border-b border-border/60 bg-muted/20 p-3"
        >
          <input
            type="text"
            aria-label="New variable key"
            placeholder="KEY_NAME"
            className={cn(PANEL_FIELD_CLASS, 'h-7 w-full px-2 font-mono text-2xs')}
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            required
          />
          <input
            type="password"
            aria-label="New variable value"
            placeholder="Value (masked)"
            className={cn(PANEL_FIELD_CLASS, 'h-7 w-full px-2 font-mono text-2xs')}
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
          />
          <div className="flex justify-end gap-1.5 pt-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" variant="default" disabled={saving}>
              Save variable
            </Button>
          </div>
        </form>
      )}

      <div className="scroller-thin min-h-0 flex-1 overflow-y-auto">
        {loadingFiles || loadingDoc ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Spinner size={14} decorative />
            Loading env files…
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <KeyRound size={22} className="text-muted-foreground/50" />
            <p className="text-xs font-medium text-foreground">No .env files found</p>
            <p className="max-w-[220px] text-2xs text-muted-foreground">
              Add a .env or .env.example file in your project root, frontend, or backend folder.
            </p>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {search.trim() ? 'No matching keys.' : 'This file has no variables yet.'}
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {filteredEntries.map((entry) => {
              const revealed = revealAll || revealedIds.has(entry.id)
              const isEditing = editingId === entry.id
              return (
                <div
                  key={entry.id}
                  data-testid={`env-row-${entry.key}`}
                  className="px-3 py-2 transition-colors hover:bg-foreground/[0.02]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-2xs font-medium text-foreground">
                      {entry.key}
                    </span>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={revealed ? `Mask ${entry.key}` : `Reveal ${entry.key}`}
                        title={revealed ? 'Mask value' : 'Reveal value'}
                        onClick={() => toggleRevealRow(entry.id)}
                        className={cn(QUIET_ICON_BUTTON_CLASS, 'size-6')}
                      >
                        {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                      <button
                        type="button"
                        aria-label={`Copy ${entry.key}`}
                        title="Copy value"
                        onClick={() => void handleCopyValue(entry.key, entry.value)}
                        className={cn(QUIET_ICON_BUTTON_CLASS, 'size-6')}
                      >
                        <Copy size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Edit ${entry.key}`}
                        title="Edit value"
                        disabled={saving}
                        onClick={() => {
                          setEditingId(entry.id)
                          setEditValue(entry.value)
                        }}
                        className={cn(QUIET_ICON_BUTTON_CLASS, 'size-6')}
                      >
                        <Edit size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${entry.key}`}
                        title="Delete variable"
                        disabled={saving}
                        onClick={() => setDeleteTarget({ id: entry.id, key: entry.key })}
                        className={cn(QUIET_ICON_BUTTON_CLASS, 'size-6 hover:text-destructive')}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <input
                        type={revealed ? 'text' : 'password'}
                        aria-label={`Edit value for ${entry.key}`}
                        className={cn(
                          PANEL_FIELD_CLASS,
                          'h-7 min-w-0 flex-1 px-2 font-mono text-2xs'
                        )}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleSaveEdit(entry.id, entry.key)
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        autoFocus
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="default"
                        disabled={saving}
                        aria-label={`Save ${entry.key}`}
                        onClick={() => void handleSaveEdit(entry.id, entry.key)}
                      >
                        <Check size={12} />
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
                      {entry.value === '' ? '(empty)' : revealed ? entry.value : '••••••••••••'}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={deleteTarget ? `Delete ${deleteTarget.key}?` : 'Delete variable?'}
        message={
          deleteTarget ? `Remove "${deleteTarget.key}" from ${selectedFile?.label ?? '.env'}?` : ''
        }
        confirmLabel="Delete"
        variant="danger"
        isLoading={saving}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => {
          if (!saving) setDeleteTarget(null)
        }}
      />
    </div>
  )
}
