/**
 * Puppeteer browser pool: a single lazily-launched Chromium instance shared
 * by every puppeteer-rendered proxy request. Each request gets its own Page
 * (created, navigated, content-read, then closed) so a slow or crashed page
 * never blocks the next one.
 *
 * The executable is auto-detected (Chrome / Edge / Chromium on the usual OS
 * paths) but can be overridden by config. A proxy server can be passed
 * through the Chromium --proxy-server flag so users behind a VPN / local
 * proxy can browse through it.
 * @module dsh-browser/host/browser-pool
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import type { Browser, Page } from 'puppeteer-core'

/** Result of one puppeteer render: the fully-executed HTML plus metadata. */
export interface RenderResult {
  html: string
  finalUrl: string
  title: string | undefined
}

/** Options passed to launch (or re-launch) the browser. */
export interface BrowserOptions {
  /** Path to a Chromium-compatible executable; auto-detected when empty. */
  executablePath?: string
  /** Proxy server passed as --proxy-server, e.g. http://127.0.0.1:7890. */
  proxyServer?: string
  /** Whether private-range addresses may be reached (SSRF override). */
  allowPrivate?: boolean
}

/** Per-render timeout (ms). */
const RENDER_TIMEOUT_MS = 30_000

/** How long to wait for the browser process to exit on close. */
const CLOSE_TIMEOUT_MS = 5_000

let browser: Browser | undefined
let currentOptions: BrowserOptions | undefined
let launchPromise: Promise<Browser> | undefined

/**
 * Auto-detect a Chromium-compatible executable on this machine. Returns the
 * first path that exists, or undefined when nothing is found.
 */
export function detectExecutablePath(): string | undefined {
  const candidates: string[] = []
  const platform = process.platform

  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? ''
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    candidates.push(
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${local}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFiles}\\Chromium\\Application\\chrome.exe`,
    )
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    )
  } else {
    // Linux: try the common binary names through `which`.
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      try {
        const path = execSync(`which ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        if (path !== '') candidates.push(path)
      } catch {
        // not installed
      }
    }
  }

  for (const path of candidates) {
    try {
      if (existsSync(path)) return path
    } catch {
      // existsSync can throw on weird paths; skip
    }
  }
  return undefined
}

/**
 * Get (or launch) the shared Browser instance. Re-launches when the options
 * change (executable path or proxy) so a settings edit takes effect without
 * a host restart.
 */
export async function getBrowser(options: BrowserOptions): Promise<Browser> {
  if (browser !== undefined && currentOptions !== undefined && optionsEqual(currentOptions, options)) {
    return browser
  }
  if (launchPromise !== undefined) return launchPromise
  launchPromise = launchBrowser(options).finally(() => { launchPromise = undefined })
  return launchPromise
}

function optionsEqual(a: BrowserOptions, b: BrowserOptions): boolean {
  return a.executablePath === b.executablePath
    && a.proxyServer === b.proxyServer
    && a.allowPrivate === b.allowPrivate
}

async function launchBrowser(options: BrowserOptions): Promise<Browser> {
  // Tear down any previous instance before launching with new options.
  if (browser !== undefined) {
    await closeBrowser()
  }
  const executablePath = options.executablePath ?? detectExecutablePath()
  if (executablePath === undefined) {
    throw new Error('no Chromium-compatible browser found; install Chrome/Edge/Chromium or set browserExecutable in the plugin settings')
  }
  // Dynamic import so the host-half build keeps puppeteer-core external and
  // the module is only loaded when puppeteer rendering is actually used.
  const puppeteer = await import('puppeteer-core')
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=IsolateOrigins,site-per-process',
  ]
  if (options.proxyServer !== undefined && options.proxyServer !== '') {
    args.push(`--proxy-server=${options.proxyServer}`)
  }
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args,
    timeout: CLOSE_TIMEOUT_MS,
  })
  currentOptions = { ...options }
  return browser
}

/** Close the shared browser (called on plugin teardown or options change). */
export async function closeBrowser(): Promise<void> {
  if (browser === undefined) return
  try {
    await browser.close()
  } catch {
    // Process may already be gone; nothing to do.
  }
  browser = undefined
  currentOptions = undefined
}

/**
 * Render one URL with Puppeteer and return the executed HTML. The page is
 * closed immediately after reading content, even on error, so the browser
 * process never accumulates zombie tabs.
 */
export async function renderUrl(url: string, options: BrowserOptions): Promise<RenderResult> {
  const instance = await getBrowser(options)
  let page: Page | undefined
  try {
    page = await instance.newPage()
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    })
    await page.setViewport({ width: 1280, height: 800 })
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: RENDER_TIMEOUT_MS,
    })
    // Give SPA frameworks an extra tick to flush post-load renders.
    await new Promise(resolve => setTimeout(resolve, 500))
    const html = await page.content()
    const finalUrl = page.url()
    let title: string | undefined
    try {
      title = await page.title()
    } catch {
      // title() can throw on detached pages
    }
    return { html, finalUrl, title }
  } finally {
    if (page !== undefined) {
      try { await page.close() } catch { /* already closed */ }
    }
  }
}
