import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoverEnvFiles,
  extractEnvEntries,
  findMissingEnvEntries,
  parseEnvDocument,
  serializeEnvDocument
} from './env-file-manager'

const mocks = vi.hoisted(() => ({
  readDirectory: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    readDirectory: mocks.readDirectory
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('env-file-manager parser and serializer', () => {
  it('round-trips comments, blank lines, export prefixes, and quoted values', () => {
    const raw = [
      '# Database config',
      'DATABASE_URL="postgres://user:pass#1@localhost:5432/app"',
      '',
      'export API_PORT=8000 # backend port',
      "APP_NAME='Karsa App'",
      'EMPTY_KEY='
    ].join('\n')

    const doc = parseEnvDocument(raw)
    const entries = extractEnvEntries(doc)
    expect(entries.map((e) => [e.key, e.value, e.hasExportPrefix])).toEqual([
      ['DATABASE_URL', 'postgres://user:pass#1@localhost:5432/app', false],
      ['API_PORT', '8000', true],
      ['APP_NAME', 'Karsa App', false],
      ['EMPTY_KEY', '', false]
    ])

    const serialized = serializeEnvDocument(doc)
    expect(serialized).toContain('# Database config')
    expect(serialized).toContain('DATABASE_URL="postgres://user:pass#1@localhost:5432/app"')
    expect(serialized).toContain('export API_PORT=8000')
    expect(serialized).toContain('APP_NAME="Karsa App"')
    expect(serialized).toContain('EMPTY_KEY=')
  })

  it('finds keys present in .env.example that are missing from .env', () => {
    const current = parseEnvDocument('PORT=3000\n')
    const example = parseEnvDocument('PORT=3000\nAPI_URL=http://localhost:8000\nSECRET_KEY=\n')
    expect(findMissingEnvEntries(current, example)).toEqual([
      { key: 'API_URL', value: 'http://localhost:8000' },
      { key: 'SECRET_KEY', value: '' }
    ])
  })
})

describe('discoverEnvFiles', () => {
  it('discovers .env and .env.example across frontend and backend folders', async () => {
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
              name: '.env',
              path: '/work/internity/frontend/.env',
              type: 'file',
              extension: 'env',
              size: 40,
              modifiedAt: 0,
              ignored: true
            },
            {
              name: '.env.example',
              path: '/work/internity/frontend/.env.example',
              type: 'file',
              extension: 'example',
              size: 40,
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
              name: '.env.example',
              path: '/work/internity/backend/.env.example',
              type: 'file',
              extension: 'example',
              size: 40,
              modifiedAt: 0
            }
          ]
        }
      }
      return { success: true, data: [] }
    })

    const files = await discoverEnvFiles('/work/internity')
    expect(
      files.map((f) => ({ label: f.label, isExample: f.isExample, ex: f.siblingExamplePath }))
    ).toEqual([
      {
        label: 'frontend/.env',
        isExample: false,
        ex: '/work/internity/frontend/.env.example'
      },
      {
        label: 'backend/.env.example',
        isExample: true,
        ex: undefined
      },
      {
        label: 'frontend/.env.example',
        isExample: true,
        ex: undefined
      }
    ])
  })
})
