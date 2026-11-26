import type { DirectoryEntry, DiscoveredGitRepo } from '@shared/types/ipc.types'
import { filesystemApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { normalizePath } from '@/lib/working-copy'

export interface StackServiceConfig {
  id: string
  name: string
  cwd: string
  relativePath: string
  command: string
  runtimeLabel: string
  custom?: boolean
}

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
  'vendor',
  '.idea',
  '.vscode'
])

const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI/OSC escape stripping
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

const LOCAL_URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(?:\/[^\s"'`<>)]*)?/gi

const ERROR_PATTERNS: readonly RegExp[] = [
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError):/,
  /\bEADDRINUSE\b/,
  /\bECONNREFUSED\b/,
  /\bUnhandledPromiseRejection\b/i,
  /\bTraceback \(most recent call last\):/,
  /\bthread ['"][^'"]+['"] panicked\b/,
  /\bpanic:\s/,
  /\bFATAL\b/,
  /\bELIFECYCLE\b/,
  /\bFailed to compile\b/i,
  /\bBuild failed\b/i,
  /\bCannot find module\b/,
  /\berror\[E\d+\]:/
]

function joinPath(base: string, child: string): string {
  const cleanBase = base.replace(/[\\/]+$/, '')
  const sep = cleanBase.includes('\\') && !cleanBase.includes('/') ? '\\' : '/'
  return `${cleanBase}${sep}${child}`
}

function baseName(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return idx >= 0 ? clean.slice(idx + 1) : clean
}

function relativeLabel(root: string, target: string): string {
  const normRoot = normalizePath(root).replace(/\/+$/, '')
  const normTarget = normalizePath(target).replace(/\/+$/, '')
  if (normTarget === normRoot) return '.'
  if (normTarget.startsWith(`${normRoot}/`)) {
    return normTarget.slice(normRoot.length + 1)
  }
  return baseName(target)
}

function detectNodePackageManager(entryNames: ReadonlySet<string>): string {
  if (entryNames.has('bun.lock') || entryNames.has('bun.lockb')) return 'bun run'
  if (entryNames.has('pnpm-lock.yaml')) return 'pnpm'
  if (entryNames.has('yarn.lock')) return 'yarn'
  return 'npm run'
}

function detectNodeRuntimeLabel(pkg: Record<string, unknown>): string {
  const deps: Record<string, unknown> = {
    ...(typeof pkg.dependencies === 'object' && pkg.dependencies ? pkg.dependencies : {}),
    ...(typeof pkg.devDependencies === 'object' && pkg.devDependencies ? pkg.devDependencies : {})
  }
  if ('next' in deps) return 'Next.js'
  if ('vite' in deps) return 'Vite'
  if ('@nestjs/core' in deps) return 'NestJS'
  if ('nuxt' in deps) return 'Nuxt'
  if ('astro' in deps) return 'Astro'
  if ('express' in deps || 'fastify' in deps || 'hono' in deps) return 'Node API'
  return 'Node'
}

const PREFERRED_SCRIPTS = ['dev', 'start:dev', 'develop', 'serve', 'start'] as const

async function inspectCandidateDirectory(
  projectRoot: string,
  dirPath: string
): Promise<StackServiceConfig | null> {
  const listRes = await filesystemApi.readDirectory(dirPath).catch(() => null)
  if (!listRes?.success || !listRes.data) return null

  const entries = listRes.data
  const fileNames = new Set(entries.filter((e) => e.type === 'file').map((e) => e.name))
  const rel = relativeLabel(projectRoot, dirPath)
  const name = rel === '.' ? baseName(projectRoot) || 'root' : rel.replace(/\//g, ' / ')
  const id = `auto:${normalizePath(dirPath)}`

  if (fileNames.has('package.json')) {
    const pkgRes = await filesystemApi.readFile(joinPath(dirPath, 'package.json')).catch(() => null)
    if (pkgRes?.success && pkgRes.data) {
      try {
        const parsed = JSON.parse(pkgRes.data.content) as Record<string, unknown>
        const scripts =
          typeof parsed.scripts === 'object' && parsed.scripts
            ? (parsed.scripts as Record<string, unknown>)
            : null
        if (scripts) {
          const picked = PREFERRED_SCRIPTS.find(
            (key) => typeof scripts[key] === 'string' && String(scripts[key]).trim().length > 0
          )
          if (picked) {
            const pm = detectNodePackageManager(fileNames)
            const command = pm === 'yarn' ? `yarn ${picked}` : `${pm} ${picked}`
            return {
              id,
              name,
              cwd: dirPath,
              relativePath: rel,
              command,
              runtimeLabel: detectNodeRuntimeLabel(parsed)
            }
          }
        }
      } catch (err) {
        void logFrontendError({
          level: 'warn',
          source: 'stack-discovery',
          message: `Failed to parse package.json in ${rel}: ${String(err)}`
        })
      }
    }
  }

  if (fileNames.has('go.mod')) {
    return {
      id,
      name,
      cwd: dirPath,
      relativePath: rel,
      command: 'go run .',
      runtimeLabel: 'Go'
    }
  }

  if (fileNames.has('Cargo.toml') && baseName(dirPath) !== 'src-tauri') {
    return {
      id,
      name,
      cwd: dirPath,
      relativePath: rel,
      command: 'cargo run',
      runtimeLabel: 'Rust'
    }
  }

  if (fileNames.has('manage.py')) {
    return {
      id,
      name,
      cwd: dirPath,
      relativePath: rel,
      command: 'python manage.py runserver',
      runtimeLabel: 'Django'
    }
  }

  if (
    (fileNames.has('pyproject.toml') || fileNames.has('requirements.txt')) &&
    (fileNames.has('main.py') || fileNames.has('app.py'))
  ) {
    const entry = fileNames.has('main.py') ? 'main.py' : 'app.py'
    return {
      id,
      name,
      cwd: dirPath,
      relativePath: rel,
      command: `python ${entry}`,
      runtimeLabel: 'Python'
    }
  }

  return null
}

/**
 * Discover runnable dev services in `projectRoot` and its sub-repos / first-level folders.
 * When nested services (e.g. `frontend`, `backend`) exist alongside a root package.json,
 * every runnable service is returned so the user can start them individually or all at once.
 */
export async function discoverStackServices(
  projectRoot: string,
  repos: readonly DiscoveredGitRepo[] = []
): Promise<StackServiceConfig[]> {
  if (!projectRoot) return []

  const seen = new Set<string>()
  const candidateDirs: string[] = []
  const addDir = (dir: string) => {
    const key = normalizePath(dir)
    if (!key || seen.has(key)) return
    seen.add(key)
    candidateDirs.push(dir)
  }

  for (const repo of repos) {
    addDir(repo.path)
  }
  addDir(projectRoot)

  const rootList = await filesystemApi.readDirectory(projectRoot).catch(() => null)
  if (rootList?.success && rootList.data) {
    const subdirs = rootList.data.filter(
      (entry: DirectoryEntry) =>
        entry.type === 'directory' &&
        !entry.name.startsWith('.') &&
        !SKIP_DIRS.has(entry.name) &&
        !entry.ignored
    )
    for (const sub of subdirs) {
      addDir(sub.path)
    }
  }

  const results = await Promise.all(
    candidateDirs.map((dir) => inspectCandidateDirectory(projectRoot, dir))
  )
  return results
    .filter((item): item is StackServiceConfig => item !== null)
    .sort((a, b) => {
      if (a.relativePath === '.' && b.relativePath !== '.') return 1
      if (b.relativePath === '.' && a.relativePath !== '.') return -1
      return a.relativePath.localeCompare(b.relativePath)
    })
}

/** Remove ANSI terminal escape codes so logs are clean for URL detection and AI chat prompts. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(/\r/g, '')
}

/** Extract unique localhost URLs from the recent tail of a terminal transcript. */
export function extractDetectedUrls(transcript: string): string[] {
  const clean = stripAnsi(transcript.slice(-12_000))
  const found = new Set<string>()
  for (const match of clean.matchAll(LOCAL_URL_PATTERN)) {
    const rawUrl = match[0]
    const normalized = rawUrl
      .replace('0.0.0.0', 'localhost')
      .replace('[::1]', 'localhost')
      .replace(/[.,;]+$/, '')
    found.add(normalized)
  }
  return [...found]
}

/** Detect whether the recent tail of a service transcript shows a runtime or build crash. */
export function detectTranscriptError(transcript: string, exitCode: number | null): boolean {
  if (exitCode !== null && exitCode !== 0) return true
  if (!transcript) return false
  const lines = stripAnsi(transcript.slice(-10_000))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-50)
  return lines.some((line) => ERROR_PATTERNS.some((pattern) => pattern.test(line)))
}

/** Build a clean, editable troubleshooting prompt from the tail of a service's terminal output. */
export function buildFixInChatPrompt(
  service: Pick<StackServiceConfig, 'name' | 'cwd' | 'command'>,
  transcript: string,
  exitCode: number | null
): string {
  const lines = stripAnsi(transcript)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-55)
  const tail = lines.join('\n').slice(-6_000)
  const exitLine = exitCode !== null ? `\nExit code: ${exitCode}` : ''

  return [
    `The dev service "${service.name}" ran into an issue.`,
    `Working directory: ${service.cwd}`,
    `Command: \`${service.command}\`${exitLine}`,
    '',
    'Recent terminal output:',
    '```text',
    tail || '(no terminal output captured yet)',
    '```',
    '',
    'Please diagnose the root cause and fix it.'
  ].join('\n')
}
