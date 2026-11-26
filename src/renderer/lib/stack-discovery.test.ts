import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildFixInChatPrompt,
  detectTranscriptError,
  discoverStackServices,
  extractDetectedUrls,
  stripAnsi
} from './stack-discovery'

const mocks = vi.hoisted(() => ({
  readDirectory: vi.fn(),
  readFile: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    readDirectory: mocks.readDirectory,
    readFile: mocks.readFile
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('discoverStackServices', () => {
  it('detects frontend (Vite + bun) and backend (Go) inside a multi-repo parent project', async () => {
    mocks.readDirectory.mockImplementation(async (dir: string) => {
      if (dir === '/work/internity') {
        return {
          success: true,
          data: [
            {
              name: 'frontend',
              path: '/work/internity/frontend',
              type: 'directory',
              extension: null,
              size: 0,
              modifiedAt: 0
            },
            {
              name: 'backend',
              path: '/work/internity/backend',
              type: 'directory',
              extension: null,
              size: 0,
              modifiedAt: 0
            }
          ]
        }
      }
      if (dir === '/work/internity/frontend') {
        return {
          success: true,
          data: [
            {
              name: 'package.json',
              path: '/work/internity/frontend/package.json',
              type: 'file',
              extension: 'json',
              size: 120,
              modifiedAt: 0
            },
            {
              name: 'bun.lock',
              path: '/work/internity/frontend/bun.lock',
              type: 'file',
              extension: 'lock',
              size: 120,
              modifiedAt: 0
            }
          ]
        }
      }
      if (dir === '/work/internity/backend') {
        return {
          success: true,
          data: [
            {
              name: 'go.mod',
              path: '/work/internity/backend/go.mod',
              type: 'file',
              extension: 'mod',
              size: 50,
              modifiedAt: 0
            }
          ]
        }
      }
      return { success: true, data: [] }
    })

    mocks.readFile.mockResolvedValue({
      success: true,
      data: {
        path: '/work/internity/frontend/package.json',
        content: JSON.stringify({
          scripts: { dev: 'vite' },
          devDependencies: { vite: '^6.0.0' }
        }),
        encoding: 'utf-8',
        size: 80
      }
    })

    const services = await discoverStackServices('/work/internity')
    expect(services).toEqual([
      {
        id: 'auto:/work/internity/backend',
        name: 'backend',
        cwd: '/work/internity/backend',
        relativePath: 'backend',
        command: 'go run .',
        runtimeLabel: 'Go'
      },
      {
        id: 'auto:/work/internity/frontend',
        name: 'frontend',
        cwd: '/work/internity/frontend',
        relativePath: 'frontend',
        command: 'bun run dev',
        runtimeLabel: 'Vite'
      }
    ])
  })
})

describe('stack-discovery transcript helpers', () => {
  it('strips ANSI codes and extracts normalized localhost URLs', () => {
    const raw =
      '\u001b[32m➜  Local:\u001b[0m   http://0.0.0.0:5173/\nAPI on http://127.0.0.1:8080/api'
    expect(stripAnsi(raw)).toContain('http://0.0.0.0:5173/')
    expect(extractDetectedUrls(raw)).toEqual([
      'http://localhost:5173/',
      'http://127.0.0.1:8080/api'
    ])
  })

  it('detects runtime errors from exit codes or stack traces', () => {
    expect(detectTranscriptError('Server ready on :3000', null)).toBe(false)
    expect(detectTranscriptError('Server exited', 1)).toBe(true)
    expect(
      detectTranscriptError('Error: listen EADDRINUSE: address already in use :::8000', null)
    ).toBe(true)
    expect(detectTranscriptError('TypeError: Cannot read properties of undefined', null)).toBe(true)
  })

  it('builds a clean Fix in Chat prompt containing service details and stripped logs', () => {
    const prompt = buildFixInChatPrompt(
      { name: 'backend', cwd: '/work/internity/backend', command: 'bun run dev' },
      '\u001b[31mTypeError: db is null\u001b[0m\n  at auth.ts:42',
      1
    )
    expect(prompt).toContain('backend')
    expect(prompt).toContain('/work/internity/backend')
    expect(prompt).toContain('Exit code: 1')
    expect(prompt).toContain('TypeError: db is null')
    expect(prompt).not.toContain('\u001b[31m')
  })
})
