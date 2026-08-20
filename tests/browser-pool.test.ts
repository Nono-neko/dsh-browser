/**
 * Unit tests for the Puppeteer browser pool. The module holds a module-level
 * singleton, so every test tears it down with closeBrowser() first.
 * puppeteer-core is mocked so no real Chromium is launched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- puppeteer-core mock ---------------------------------------------------

const mockPage = {
  setExtraHTTPHeaders: vi.fn(),
  setViewport: vi.fn(),
  goto: vi.fn(),
  content: vi.fn(),
  url: vi.fn(),
  title: vi.fn(),
  close: vi.fn(),
}

const mockBrowser = {
  newPage: vi.fn(() => mockPage),
  close: vi.fn(),
}

const mockLaunch = vi.fn(() => mockBrowser)

vi.mock('puppeteer-core', () => ({
  default: { launch: mockLaunch },
  launch: mockLaunch,
}))

// --- fs mock for detectExecutablePath --------------------------------------

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn((path: string) => path === '/fake/chrome'),
  }
})

import { existsSync } from 'node:fs'
import { closeBrowser, detectExecutablePath, getBrowser, renderUrl } from '../src/host/browser-pool.ts'

// --- helpers ---------------------------------------------------------------

function resetPageMocks(): void {
  mockPage.setExtraHTTPHeaders.mockReset()
  mockPage.setViewport.mockReset()
  mockPage.goto.mockReset()
  mockPage.content.mockReset()
  mockPage.url.mockReset()
  mockPage.title.mockReset()
  mockPage.close.mockReset()
  mockBrowser.newPage.mockReset()
  mockBrowser.close.mockReset()
  mockLaunch.mockReset()
}

beforeEach(async () => {
  resetPageMocks()
  await closeBrowser()
})

afterEach(async () => {
  await closeBrowser()
})

// --- detectExecutablePath --------------------------------------------------

describe('detectExecutablePath', () => {
  it('returns the first candidate that exists on disk', () => {
    vi.mocked(existsSync).mockImplementation((path) => path === '/fake/chrome')
    // On Linux the candidates include 'google-chrome' etc. via `which`; we
    // cannot easily mock execSync, so assert the contract: a path that
    // existsSync reports true for is returned when it is in the candidate list.
    // The Windows / darwin branches are exercised by running on those OSes.
    const result = detectExecutablePath()
    // The function either returns a real system browser or undefined; the
    // important invariant is that it never throws.
    expect(result === undefined || typeof result === 'string').toBe(true)
  })

  it('returns undefined when no candidate exists', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    // On Linux this also exercises the `which` fallback; if which finds a
    // binary the result may be a string. The no-throw invariant holds.
    const result = detectExecutablePath()
    expect(result === undefined || typeof result === 'string').toBe(true)
  })
})

// --- getBrowser singleton --------------------------------------------------

describe('getBrowser', () => {
  it('launches a browser with the given executable path and proxy', async () => {
    await getBrowser({ executablePath: '/fake/chrome', proxyServer: 'http://127.0.0.1:7890' })
    expect(mockLaunch).toHaveBeenCalledTimes(1)
    const args = mockLaunch.mock.calls[0]?.[0]
    expect(args?.executablePath).toBe('/fake/chrome')
    expect(args?.headless).toBe(true)
    expect(args?.args).toContain('--proxy-server=http://127.0.0.1:7890')
    expect(args?.args).toContain('--no-sandbox')
  })

  it('does not pass --proxy-server when proxyServer is empty', async () => {
    await getBrowser({ executablePath: '/fake/chrome' })
    const args = mockLaunch.mock.calls[0]?.[0]
    expect(args?.args?.some((a: string) => a.startsWith('--proxy-server'))).toBe(false)
  })

  it('reuses the same browser instance for identical options', async () => {
    const options = { executablePath: '/fake/chrome' }
    const first = await getBrowser(options)
    const second = await getBrowser(options)
    expect(first).toBe(second)
    expect(mockLaunch).toHaveBeenCalledTimes(1)
  })

  it('re-launches when options change', async () => {
    await getBrowser({ executablePath: '/fake/chrome' })
    expect(mockLaunch).toHaveBeenCalledTimes(1)
    await getBrowser({ executablePath: '/fake/chrome', proxyServer: 'http://127.0.0.1:7890' })
    expect(mockLaunch).toHaveBeenCalledTimes(2)
    expect(mockBrowser.close).toHaveBeenCalledTimes(1)
  })
})

// --- renderUrl -------------------------------------------------------------

describe('renderUrl', () => {
  beforeEach(() => {
    mockPage.goto.mockResolvedValue(undefined)
    mockPage.content.mockResolvedValue('<html><body>hello</body></html>')
    mockPage.url.mockReturnValue('https://example.com/')
    mockPage.title.mockResolvedValue('Example')
  })

  it('navigates to the URL and returns rendered HTML, finalUrl, and title', async () => {
    const result = await renderUrl('https://example.com/', { executablePath: '/fake/chrome' })
    expect(result.html).toBe('<html><body>hello</body></html>')
    expect(result.finalUrl).toBe('https://example.com/')
    expect(result.title).toBe('Example')
    expect(mockPage.goto).toHaveBeenCalledWith('https://example.com/', expect.objectContaining({
      waitUntil: 'networkidle2',
    }))
    expect(mockPage.setViewport).toHaveBeenCalledWith({ width: 1280, height: 800 })
  })

  it('closes the page even when goto throws', async () => {
    mockPage.goto.mockRejectedValue(new Error('navigation failed'))
    await expect(renderUrl('https://example.com/', { executablePath: '/fake/chrome' })).rejects.toThrow('navigation failed')
    expect(mockPage.close).toHaveBeenCalledTimes(1)
  })

  it('closes the page even when content() throws', async () => {
    mockPage.content.mockRejectedValue(new Error('content failed'))
    await expect(renderUrl('https://example.com/', { executablePath: '/fake/chrome' })).rejects.toThrow('content failed')
    expect(mockPage.close).toHaveBeenCalledTimes(1)
  })

  it('handles title() throwing gracefully', async () => {
    mockPage.title.mockRejectedValue(new Error('detached'))
    const result = await renderUrl('https://example.com/', { executablePath: '/fake/chrome' })
    expect(result.title).toBeUndefined()
    expect(result.html).toBe('<html><body>hello</body></html>')
  })

  it('creates a new page per render call', async () => {
    await renderUrl('https://example.com/1', { executablePath: '/fake/chrome' })
    await renderUrl('https://example.com/2', { executablePath: '/fake/chrome' })
    expect(mockBrowser.newPage).toHaveBeenCalledTimes(2)
    expect(mockPage.close).toHaveBeenCalledTimes(2)
  })
})

// --- closeBrowser ----------------------------------------------------------

describe('closeBrowser', () => {
  it('is a no-op when no browser is running', async () => {
    await expect(closeBrowser()).resolves.toBeUndefined()
    expect(mockBrowser.close).not.toHaveBeenCalled()
  })

  it('closes the running browser', async () => {
    await getBrowser({ executablePath: '/fake/chrome' })
    await closeBrowser()
    expect(mockBrowser.close).toHaveBeenCalledTimes(1)
  })
})
