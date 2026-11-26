import type { DirectoryEntry, DiscoveredGitRepo } from '@shared/types/ipc.types'
import { filesystemApi } from '@/lib/api'
import { normalizePath } from '@/lib/working-copy'

export type EnvDocumentLine =
  | { kind: 'blank'; raw: string }
  | { kind: 'comment'; raw: string }
  | {
      kind: 'entry'
      id: string
      key: string
      value: string
      hasExportPrefix: boolean
    }

export interface EnvDocument {
  lines: EnvDocumentLine[]
}

export interface DiscoveredEnvFile {
  path: string
  name: string
  dirPath: string
  /** Display label such as `.env` or `frontend/.env`. */
  label: string
  /** Subfolder label (`frontend`, `backend`, or `root`). */
  scopeLabel: string
  isExample: boolean
  siblingExamplePath?: string
}

const ENV_FILE_PATTERN = /^\.env(?:\.[a-zA-Z0-9_-]+)?$/
const EXAMPLE_FILE_PATTERN = /^\.env\.(?:example|sample|template)$/i
const ENTRY_LINE_PATTERN = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'coverage',
  'out',
  'vendor'
])

function joinPath(base: string, child: string): string {
  const cleanBase = base.replace(/[\\/]+$/, '')
  const sep = cleanBase.includes('\\') && !cleanBase.includes('/') ? '\\' : '/'
  return `${cleanBase}${sep}${child}`
}

function unquoteEnvValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  // Strip trailing inline comment preceded by whitespace on unquoted values.
  const commentIndex = trimmed.search(/\s+#/)
  return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trimEnd() : trimmed
}

function formatEnvValue(value: string): string {
  if (value === '') return ''
  const needsQuotes = /[\s#"'`\\\r\n]/.test(value)
  if (!needsQuotes) return value
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/** Parse a `.env` file while preserving comments, blank lines, and ordering. */
export function parseEnvDocument(raw: string): EnvDocument {
  const rawLines = raw.replace(/\r\n/g, '\n').split('\n')
  // Drop a single trailing empty line produced by a final newline.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop()
  }

  const lines: EnvDocumentLine[] = rawLines.map((line, index) => {
    const trimmed = line.trim()
    if (trimmed === '') return { kind: 'blank', raw: line }
    if (trimmed.startsWith('#')) return { kind: 'comment', raw: line }

    const match = ENTRY_LINE_PATTERN.exec(line)
    if (!match) return { kind: 'comment', raw: line }

    const hasExportPrefix = Boolean(match[2])
    const key = match[3]
    const value = unquoteEnvValue(match[4])
    return {
      kind: 'entry',
      id: `line-${index}-${key}`,
      key,
      value,
      hasExportPrefix
    }
  })

  return { lines }
}

/** Serialize an `EnvDocument` back into valid `.env` file text. */
export function serializeEnvDocument(doc: EnvDocument): string {
  const out = doc.lines.map((line) => {
    if (line.kind !== 'entry') return line.raw
    const prefix = line.hasExportPrefix ? 'export ' : ''
    return `${prefix}${line.key}=${formatEnvValue(line.value)}`
  })
  return out.length > 0 ? `${out.join('\n')}\n` : ''
}

export function extractEnvEntries(
  doc: EnvDocument
): Array<Extract<EnvDocumentLine, { kind: 'entry' }>> {
  return doc.lines.filter(
    (line): line is Extract<EnvDocumentLine, { kind: 'entry' }> => line.kind === 'entry'
  )
}

/** Return entries defined in `.env.example` whose keys do not yet exist in `.env`. */
export function findMissingEnvEntries(
  current: EnvDocument,
  example: EnvDocument
): Array<{ key: string; value: string }> {
  const existingKeys = new Set(extractEnvEntries(current).map((entry) => entry.key))
  const seenMissing = new Set<string>()
  const missing: Array<{ key: string; value: string }> = []
  for (const entry of extractEnvEntries(example)) {
    if (!existingKeys.has(entry.key) && !seenMissing.has(entry.key)) {
      seenMissing.add(entry.key)
      missing.push({ key: entry.key, value: entry.value })
    }
  }
  return missing
}

/** Discover `.env*` files across the project root, nested git repos, and first-level folders. */
export async function discoverEnvFiles(
  projectRoot: string,
  repos: readonly DiscoveredGitRepo[] = []
): Promise<DiscoveredEnvFile[]> {
  if (!projectRoot) return []

  const normRoot = normalizePath(projectRoot).replace(/\/+$/, '')
  const seenDirs = new Set<string>()
  const candidateDirs: string[] = []
  const addDir = (dir: string) => {
    const key = normalizePath(dir).replace(/\/+$/, '')
    if (!key || seenDirs.has(key)) return
    seenDirs.add(key)
    candidateDirs.push(dir)
  }

  addDir(projectRoot)
  for (const repo of repos) {
    addDir(repo.path)
  }

  const rootList = await filesystemApi.readDirectory(projectRoot).catch(() => null)
  if (rootList?.success && rootList.data) {
    for (const entry of rootList.data) {
      if (
        entry.type === 'directory' &&
        !entry.name.startsWith('.') &&
        !SKIP_DIRS.has(entry.name) &&
        !entry.ignored
      ) {
        addDir(entry.path)
      }
    }
  }

  const discovered: DiscoveredEnvFile[] = []
  await Promise.all(
    candidateDirs.map(async (dir) => {
      const list = await filesystemApi.readDirectory(dir).catch(() => null)
      if (!list?.success || !list.data) return
      const envEntries = list.data.filter(
        (entry: DirectoryEntry) => entry.type === 'file' && ENV_FILE_PATTERN.test(entry.name)
      )
      if (envEntries.length === 0) return

      const normDir = normalizePath(dir).replace(/\/+$/, '')
      const relDir = normDir.startsWith(`${normRoot}/`) ? normDir.slice(normRoot.length + 1) : ''
      const scopeLabel = relDir || 'root'
      const exampleEntry = envEntries.find((e) => EXAMPLE_FILE_PATTERN.test(e.name))

      for (const entry of envEntries) {
        const isExample = EXAMPLE_FILE_PATTERN.test(entry.name)
        discovered.push({
          path: entry.path || joinPath(dir, entry.name),
          name: entry.name,
          dirPath: dir,
          label: relDir ? `${relDir}/${entry.name}` : entry.name,
          scopeLabel,
          isExample,
          siblingExamplePath: !isExample && exampleEntry ? exampleEntry.path : undefined
        })
      }
    })
  )

  return discovered.sort((a, b) => {
    if (a.isExample !== b.isExample) return a.isExample ? 1 : -1
    return a.label.localeCompare(b.label)
  })
}

export function buildSiblingDotEnvPath(exampleFile: DiscoveredEnvFile): string {
  return joinPath(exampleFile.dirPath, '.env')
}
