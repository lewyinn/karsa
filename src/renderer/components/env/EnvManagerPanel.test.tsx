import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvManagerPanel } from './EnvManagerPanel'

const mocks = vi.hoisted(() => ({
  readDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    readDirectory: mocks.readDirectory,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readDirectory.mockImplementation(async (dir: string) => {
    if (dir === '/work/internity') {
      return {
        success: true,
        data: [
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
    if (dir === '/work/internity/backend') {
      return {
        success: true,
        data: [
          {
            name: '.env',
            path: '/work/internity/backend/.env',
            type: 'file',
            extension: 'env',
            size: 32,
            modifiedAt: 0,
            ignored: true
          },
          {
            name: '.env.example',
            path: '/work/internity/backend/.env.example',
            type: 'file',
            extension: 'example',
            size: 64,
            modifiedAt: 0
          }
        ]
      }
    }
    return { success: true, data: [] }
  })

  mocks.readFile.mockImplementation(async (path: string) => {
    if (path === '/work/internity/backend/.env') {
      return {
        success: true,
        data: { path, content: 'DB_SECRET=super-secret-value\n', encoding: 'utf-8', size: 29 }
      }
    }
    if (path === '/work/internity/backend/.env.example') {
      return {
        success: true,
        data: {
          path,
          content: 'DB_SECRET=\nREDIS_URL=redis://localhost:6379\n',
          encoding: 'utf-8',
          size: 45
        }
      }
    }
    return { success: false, error: 'not found' }
  })

  mocks.writeFile.mockResolvedValue({ success: true })
})

describe('EnvManagerPanel', () => {
  it('masks secret values by default, reveals on toggle, and adds missing keys from .env.example', async () => {
    render(<EnvManagerPanel projectRoot="/work/internity" repos={[]} />)

    const row = await screen.findByTestId('env-row-DB_SECRET')
    expect(row).not.toHaveTextContent('super-secret-value')
    expect(row).toHaveTextContent('••••••••••••')

    // Reveal single row
    fireEvent.click(screen.getByRole('button', { name: 'Reveal DB_SECRET' }))
    expect(row).toHaveTextContent('super-secret-value')

    // Missing key banner from .env.example
    expect(screen.getByText(/1 key missing from example/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add missing' }))

    await waitFor(() =>
      expect(mocks.writeFile).toHaveBeenCalledWith(
        '/work/internity/backend/.env',
        expect.stringContaining('REDIS_URL=redis://localhost:6379')
      )
    )
  })
})
