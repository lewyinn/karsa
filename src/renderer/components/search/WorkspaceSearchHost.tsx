import type { DiscoveredGitRepo, SearchFileHit } from '@shared/types/ipc.types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MaterialFileIcon } from '@/components/file-explorer/MaterialFileIcon'
import { FileText, Search } from '@/components/icons'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { filesystemApi } from '@/lib/api'
import { gitApi } from '@/lib/git-api'
import { logFrontendError } from '@/lib/log-api'
import { basename } from '@/lib/path-basename'
import { cn } from '@/lib/utils'
import { randomUUID } from '@/lib/uuid'
import { useEditorStore } from '@/stores/editor-store'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

type SearchModalMode = 'files' | 'content'

interface ContentMatchRow {
  filePath: string
  relPath: string
  repoLabel: string | null
  lineNumber: number
  lineText: string
}

interface FileHitRow {
  absPath: string
  relPath: string
  name: string
  dir: string
  repoLabel: string | null
}

const MAX_FILE_HITS = 80
const MAX_CONTENT_MATCHES = 120

function normSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '')
}

function repoLabelForPath(absPath: string, repos: readonly DiscoveredGitRepo[]): string | null {
  if (repos.length <= 1) return null
  const normFile = normSlashes(absPath).toLowerCase()
  for (const repo of repos) {
    const normRepo = normSlashes(repo.path).toLowerCase()
    if (normFile === normRepo || normFile.startsWith(`${normRepo}/`)) {
      return repo.name
    }
  }
  return null
}

function relativeToRoot(absPath: string, root: string): string {
  const normFile = normSlashes(absPath)
  const normRoot = normSlashes(root)
  if (normFile.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
    return normFile.slice(normRoot.length + 1)
  }
  return normFile
}

async function openFileAtLine(
  filePath: string,
  lineNumber?: number,
  searchTerm?: string
): Promise<void> {
  await useEditorStore.getState().openFile(filePath)
  useWorkspaceStore.getState().addEditorTab(filePath)
  if (lineNumber !== undefined) {
    if (/\.md$/i.test(filePath)) {
      useEditorStore.getState().setViewMode(filePath, 'code')
    }
    useEditorStore.getState().updateCursorPosition(filePath, lineNumber, 1)
    const detail = { filePath, lineNumber, searchTerm: searchTerm?.trim() || undefined }
    ;(
      window as unknown as { __termulPendingRevealLine?: typeof detail }
    ).__termulPendingRevealLine = detail
    window.dispatchEvent(new CustomEvent('termul:reveal-line', { detail }))
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('termul:reveal-line', { detail }))
    })
  }
}

/**
 * Global Quick File Open (`Ctrl+P` / `Cmd+P`) & Global Search in Files
 * (`Ctrl+Shift+F` / `Cmd+Shift+F`) modal across the active project and all
 * nested multi-repo workspaces. Mounted once in both `TauriApp` and `App`.
 */
export function WorkspaceSearchHost(): React.JSX.Element {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const projects = useProjectStore((s) => s.projects)
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  )
  const projectRoot = activeProject?.path ? normSlashes(activeProject.path) : ''

  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<SearchModalMode>('files')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [fileHits, setFileHits] = useState<FileHitRow[]>([])
  const [contentRows, setContentRows] = useState<ContentMatchRow[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [repos, setRepos] = useState<DiscoveredGitRepo[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const activeSearchIdRef = useRef<string | null>(null)
  const contentGenRef = useRef(0)

  // Global keyboard shortcuts: Ctrl+P (Quick Open) & Ctrl+Shift+F (Global Search).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'p' && !event.shiftKey) {
        event.preventDefault()
        setMode('files')
        setOpen(true)
        setSelectedIndex(0)
        return
      }
      if (key === 'f' && event.shiftKey) {
        event.preventDefault()
        setMode('content')
        setOpen(true)
        setSelectedIndex(0)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Discover nested repos once per project root when modal opens.
  useEffect(() => {
    if (!open || !projectRoot) return
    let cancelled = false
    void gitApi
      .discoverRepos(projectRoot)
      .then((found) => {
        if (!cancelled) setRepos(found)
      })
      .catch(() => {
        if (!cancelled) setRepos([])
      })
    return () => {
      cancelled = true
    }
  }, [open, projectRoot])

  // Focus input when opening or switching modes.
  useEffect(() => {
    if (!open || !mode) return
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 10)
    return () => clearTimeout(t)
  }, [open, mode])

  // File name stream search (Quick Open).
  useEffect(() => {
    if (!open || mode !== 'files' || !projectRoot) return

    const searchId = randomUUID()
    activeSearchIdRef.current = searchId
    const collected: FileHitRow[] = []
    let disposed = false

    const cancelCurrent = (): void => {
      if (activeSearchIdRef.current === searchId) {
        activeSearchIdRef.current = null
      }
      void filesystemApi.searchFileNamesStreamCancel(searchId).catch(() => {})
    }

    const unsubBatch = filesystemApi.onSearchFileNamesBatch((batch) => {
      if (disposed || batch.searchId !== searchId) return
      for (const hit of batch.files as SearchFileHit[]) {
        if (hit.kind === 'dir') continue
        if (collected.length >= MAX_FILE_HITS) break
        const rel = normSlashes(hit.path)
        const absPath = `${projectRoot}/${rel}`
        const name = basename(rel)
        const lastSlash = rel.lastIndexOf('/')
        const dir = lastSlash > 0 ? rel.slice(0, lastSlash) : ''
        collected.push({
          absPath,
          relPath: rel,
          name,
          dir,
          repoLabel: repoLabelForPath(absPath, repos)
        })
      }
      setFileHits([...collected])
      setSelectedIndex(0)
    })

    const unsubDone = filesystemApi.onSearchFileNamesDone((done) => {
      if (disposed || done.searchId !== searchId) return
      setLoading(false)
    })

    const timer = setTimeout(
      () => {
        if (disposed) return
        setLoading(true)
        setFileHits([])
        void filesystemApi
          .searchFileNamesStreamStart(searchId, projectRoot, projectRoot, query.trim(), false)
          .then((res) => {
            if (!res.success && !disposed) {
              setLoading(false)
            }
          })
          .catch(() => {
            if (!disposed) setLoading(false)
          })
      },
      query.trim().length >= 3 ? 60 : 120
    )

    return () => {
      disposed = true
      clearTimeout(timer)
      unsubBatch()
      unsubDone()
      cancelCurrent()
    }
  }, [open, mode, projectRoot, query, repos])

  // Global content search (Ctrl+Shift+F) via ripgrep.
  useEffect(() => {
    if (!open || mode !== 'content' || !projectRoot) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setContentRows([])
      setLoading(false)
      return
    }
    const gen = ++contentGenRef.current
    const timer = setTimeout(() => {
      setLoading(true)
      void filesystemApi
        .searchContent(projectRoot, projectRoot, trimmed)
        .then((res) => {
          if (contentGenRef.current !== gen) return
          setLoading(false)
          if (!res.success || !res.data) {
            setContentRows([])
            return
          }
          const rows: ContentMatchRow[] = []
          for (const file of res.data.results) {
            const relPath = relativeToRoot(file.filePath, projectRoot)
            const repoLabel = repoLabelForPath(file.filePath, repos)
            for (const m of file.matches) {
              if (rows.length >= MAX_CONTENT_MATCHES) break
              rows.push({
                filePath: file.filePath,
                relPath,
                repoLabel,
                lineNumber: m.lineNumber,
                lineText: m.lineText.trim()
              })
            }
            if (rows.length >= MAX_CONTENT_MATCHES) break
          }
          setContentRows(rows)
          setSelectedIndex(0)
        })
        .catch((err) => {
          if (contentGenRef.current !== gen) return
          setLoading(false)
          void logFrontendError({
            level: 'warn',
            source: 'WorkspaceSearchHost',
            message: `Global content search failed: ${String(err)}`
          })
        })
    }, 180)

    return () => clearTimeout(timer)
  }, [open, mode, projectRoot, query, repos])

  const rowCount = mode === 'files' ? fileHits.length : contentRows.length

  const selectRow = useCallback(
    (index: number) => {
      if (mode === 'files') {
        const hit = fileHits[index]
        if (!hit) return
        setOpen(false)
        void openFileAtLine(hit.absPath)
      } else {
        const row = contentRows[index]
        if (!row) return
        setOpen(false)
        void openFileAtLine(row.filePath, row.lineNumber, query)
      }
    },
    [mode, fileHits, contentRows, query]
  )

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (rowCount > 0) setSelectedIndex((i) => (i + 1) % rowCount)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (rowCount > 0) setSelectedIndex((i) => (i - 1 + rowCount) % rowCount)
    } else if (event.key === 'Enter' && rowCount > 0) {
      event.preventDefault()
      selectRow(selectedIndex)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0 [&>button:last-child]:hidden">
        <DialogTitle className="sr-only">
          {mode === 'files' ? 'Quick Open File' : 'Global Search in Files'}
        </DialogTitle>

        {/* Header with Mode Switcher + Search Input */}
        <div className="border-b border-border/70 p-2.5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="inline-flex rounded-md border border-border/70 bg-muted/30 p-0.5 text-2xs">
              <button
                type="button"
                onClick={() => {
                  setMode('files')
                  setSelectedIndex(0)
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-0.5 font-medium transition-colors',
                  mode === 'files'
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <FileText size={11} />
                Quick Open
                <span className="font-mono text-4xs text-muted-foreground">Ctrl+P</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('content')
                  setSelectedIndex(0)
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-0.5 font-medium transition-colors',
                  mode === 'content'
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Search size={11} />
                Search in Files
                <span className="font-mono text-4xs text-muted-foreground">Ctrl+Shift+F</span>
              </button>
            </div>
            {repos.length > 1 && (
              <span className="font-mono text-3xs text-muted-foreground">{repos.length} repos</span>
            )}
          </div>

          <div className="relative flex items-center">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 text-muted-foreground"
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder={
                !projectRoot
                  ? 'Open a project first to search files'
                  : mode === 'files'
                    ? 'Type a file name to open…'
                    : 'Search text across all files (min 2 chars)…'
              }
              disabled={!projectRoot}
              className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-8 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            {loading && (
              <span className="absolute right-2.5">
                <Spinner size={12} decorative />
              </span>
            )}
          </div>
        </div>

        {/* Results */}
        <div className="scroller-thin max-h-[55vh] overflow-y-auto p-1.5">
          {!projectRoot ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              Select a project with a folder to search files.
            </div>
          ) : mode === 'files' ? (
            fileHits.length === 0 ? (
              <div className="py-10 text-center text-xs text-muted-foreground">
                {loading ? 'Scanning workspace files…' : 'No matching files found.'}
              </div>
            ) : (
              <div role="listbox" aria-label="Matching files" className="space-y-0.5">
                {fileHits.map((hit, idx) => (
                  <button
                    key={hit.absPath}
                    type="button"
                    role="option"
                    aria-selected={idx === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => selectRow(idx)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                      idx === selectedIndex
                        ? 'bg-foreground/[0.08] text-foreground'
                        : 'text-secondary-foreground hover:bg-foreground/[0.04]'
                    )}
                  >
                    <MaterialFileIcon
                      name={hit.name}
                      isDirectory={false}
                      isExpanded={false}
                      depth={0}
                      size={14}
                    />
                    <span className="shrink-0 font-medium text-foreground">{hit.name}</span>
                    {hit.repoLabel && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-4xs text-secondary-foreground">
                        {hit.repoLabel}
                      </span>
                    )}
                    {hit.dir && (
                      <span className="min-w-0 truncate text-3xs text-muted-foreground">
                        {hit.dir}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )
          ) : query.trim().length < 2 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              Type at least 2 characters to search across all files in this workspace.
            </div>
          ) : contentRows.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              {loading ? 'Searching files…' : `No matches for "${query.trim()}".`}
            </div>
          ) : (
            <div role="listbox" aria-label="Search results" className="space-y-0.5">
              {contentRows.map((row, idx) => (
                <button
                  key={`${row.filePath}:${row.lineNumber}:${idx}`}
                  type="button"
                  role="option"
                  aria-selected={idx === selectedIndex}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => selectRow(idx)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
                    idx === selectedIndex
                      ? 'bg-foreground/[0.08] text-foreground'
                      : 'text-secondary-foreground hover:bg-foreground/[0.04]'
                  )}
                >
                  <div className="flex items-center gap-1.5 text-2xs">
                    {row.repoLabel && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-4xs text-secondary-foreground">
                        {row.repoLabel}
                      </span>
                    )}
                    <span className="truncate font-medium text-foreground">{row.relPath}</span>
                    <span className="shrink-0 font-mono text-3xs text-muted-foreground">
                      :{row.lineNumber}
                    </span>
                  </div>
                  <div className="truncate font-mono text-3xs text-muted-foreground">
                    {row.lineText}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
