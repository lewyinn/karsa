import type { DiscoveredGitRepo } from '@shared/types/ipc.types'
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { gitApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { normalizePath } from '@/lib/working-copy'

const EMPTY_REPOS: DiscoveredGitRepo[] = []
const inFlight = new Map<string, Promise<DiscoveredGitRepo[]>>()

interface GitReposState {
  reposByRoot: Record<string, DiscoveredGitRepo[]>
  loadedRoots: Record<string, boolean>
  selectedRepoByProject: Record<string, string>
  githubAllReposByProject: Record<string, boolean>

  discover: (rootPath: string, force?: boolean) => Promise<DiscoveredGitRepo[]>
  setSelectedRepo: (projectId: string, repoPath: string) => void
  setGithubAllRepos: (projectId: string, all: boolean) => void
}

export const useGitReposStore = create<GitReposState>((set, get) => ({
  reposByRoot: {},
  loadedRoots: {},
  selectedRepoByProject: {},
  githubAllReposByProject: {},

  discover: async (rootPath: string, force = false): Promise<DiscoveredGitRepo[]> => {
    const key = rootPath ? normalizePath(rootPath) : ''
    if (!key) return EMPTY_REPOS

    if (!force && get().loadedRoots[key]) {
      return get().reposByRoot[key] ?? EMPTY_REPOS
    }

    const existing = inFlight.get(key)
    if (existing) return existing

    if (typeof gitApi?.discoverRepos !== 'function') {
      return EMPTY_REPOS
    }

    const promise = Promise.resolve(gitApi.discoverRepos(rootPath))
      .then((raw) => {
        const repos = Array.isArray(raw) ? raw : EMPTY_REPOS
        set((state) => ({
          reposByRoot: { ...state.reposByRoot, [key]: repos },
          loadedRoots: { ...state.loadedRoots, [key]: true }
        }))
        return repos
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        void logFrontendError({
          level: 'warn',
          source: 'git-repos-store',
          message: `git_discover_repos failed for ${rootPath}: ${message}`
        })
        set((state) => ({
          reposByRoot: { ...state.reposByRoot, [key]: state.reposByRoot[key] ?? EMPTY_REPOS },
          loadedRoots: { ...state.loadedRoots, [key]: true }
        }))
        return get().reposByRoot[key] ?? EMPTY_REPOS
      })
      .finally(() => {
        inFlight.delete(key)
      })

    inFlight.set(key, promise)
    return promise
  },

  setSelectedRepo: (projectId: string, repoPath: string) => {
    set((state) => ({
      selectedRepoByProject: { ...state.selectedRepoByProject, [projectId]: repoPath },
      githubAllReposByProject: { ...state.githubAllReposByProject, [projectId]: false }
    }))
  },

  setGithubAllRepos: (projectId: string, all: boolean) => {
    set((state) => ({
      githubAllReposByProject: { ...state.githubAllReposByProject, [projectId]: all }
    }))
  }
}))

/** True when a workspace has multiple repos or a nested sub-repo under a non-git root. */
export function isMultiRepoWorkspace(repos: readonly DiscoveredGitRepo[]): boolean {
  return repos.length > 1 || (repos.length === 1 && !repos[0].isRoot)
}

export interface ProjectGitReposResult {
  repos: DiscoveredGitRepo[]
  loaded: boolean
  isMultiRepo: boolean
  activeRepo: DiscoveredGitRepo | null
  activeRepoPath: string
  githubAllRepos: boolean
  setSelectedRepo: (repoPath: string) => void
  setGithubAllRepos: (all: boolean) => void
  refresh: () => void
}

/**
 * Discovers Git repositories under `rootPath` and resolves the synced active
 * repo for `projectId` (shared by Changes and GitHub panels).
 */
export function useProjectGitRepos(projectId: string, rootPath: string): ProjectGitReposResult {
  const key = rootPath ? normalizePath(rootPath) : ''
  const repos = useGitReposStore((s) => (key ? (s.reposByRoot[key] ?? EMPTY_REPOS) : EMPTY_REPOS))
  const loaded = useGitReposStore((s) => (key ? Boolean(s.loadedRoots[key]) : true))
  const savedSelection = useGitReposStore((s) =>
    projectId ? s.selectedRepoByProject[projectId] : undefined
  )
  const savedAll = useGitReposStore((s) =>
    projectId ? Boolean(s.githubAllReposByProject[projectId]) : false
  )

  useEffect(() => {
    if (!rootPath) return
    void useGitReposStore.getState().discover(rootPath)
  }, [rootPath])

  const isMultiRepo = isMultiRepoWorkspace(repos)

  const activeRepo = useMemo(() => {
    if (repos.length === 0) return null
    if (savedSelection) {
      const normalizedSaved = normalizePath(savedSelection)
      const match = repos.find((r) => normalizePath(r.path) === normalizedSaved)
      if (match) return match
    }
    return repos[0] ?? null
  }, [repos, savedSelection])

  const activeRepoPath = activeRepo?.path ?? rootPath
  const githubAllRepos = repos.length > 1 && savedAll

  return {
    repos,
    loaded,
    isMultiRepo,
    activeRepo,
    activeRepoPath,
    githubAllRepos,
    setSelectedRepo: (repoPath: string) => {
      if (projectId) useGitReposStore.getState().setSelectedRepo(projectId, repoPath)
    },
    setGithubAllRepos: (all: boolean) => {
      if (projectId) useGitReposStore.getState().setGithubAllRepos(projectId, all)
    },
    refresh: () => {
      if (rootPath) void useGitReposStore.getState().discover(rootPath, true)
    }
  }
}

export function resetGitReposStoreForTests(): void {
  inFlight.clear()
  useGitReposStore.setState({
    reposByRoot: {},
    loadedRoots: {},
    selectedRepoByProject: {},
    githubAllReposByProject: {}
  })
}
