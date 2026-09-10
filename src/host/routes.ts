/**
 * /api/dsh-browser route layer: one SSE stream pushing open events from the
 * agent tools into the GUI panel, plus the workspace listing and file-serving
 * routes the start page browses. Every route is loopback-fenced (a LAN-exposed
 * dsh web must not serve workspace files to unpaired devices) and every fs
 * operation is workspace-gated (the same boundary dsh-aionui-panel applies).
 *
 * The loopback fence and JSON envelope mirror the dsh-web-ui family's
 * dsh-ssh / dsh-aionui-panel route conventions (Apache-2.0).
 * @module dsh-browser/host/routes
 */

import { randomUUID } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { UpdateService } from './update-service.ts'
import { handleUpdateRoute } from './update-routes.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { BrowserEnvelope, BrowserEvent, BrowserError, WorkspaceListing } from '../core/types.ts'
import { captureUrl, closeBrowser, renderUrl, type BrowserOptions } from './browser-pool.ts'
import type { WorkspaceGate } from './gate.ts'
import { forbidden, isLoopbackPreviewResourceRequest, isLoopbackRequest, isPreviewToken, json, safely } from './http.ts'
import { handleReviewRoute } from './review-routes.ts'
import { reviewBridgeScript } from './review-bridge.ts'
import type { ReviewStore } from './review-store.ts'
import { handleSourceRoute } from './source-routes.ts'
import { resolveInside } from './workspace-path.ts'
import { createLoopbackPreviewServer } from './preview-server.ts'

const OK = <T>(value: T): BrowserEnvelope<T> => ({ ok: true, value })
const FAIL = (error: BrowserError): BrowserEnvelope<never> => ({ ok: false, error })
const BAD_REQUEST: BrowserError = { code: 'bad-request', message: 'malformed request' }
const SCREENSHOT_ROUTE = '/api/dsh-browser/screenshot'
const PREVIEW_SESSION_ROUTE = '/api/dsh-browser/preview-session'

/** SSE keep-alive interval (proxies drop idle connections). */
const HEARTBEAT_MS = 15_000

/** Maximum file size served through the file route (larger answers too-large). */
const MAX_FILE_BYTES = 64 * 1024 * 1024

/** Maximum HTML size that gets a <base> injection (larger is streamed as-is). */
const MAX_BASE_INJECT_BYTES = 8 * 1024 * 1024
const MIN_CAPTURE_WIDTH = 320
const MAX_CAPTURE_WIDTH = 1_920
const MIN_CAPTURE_HEIGHT = 240
const MAX_CAPTURE_HEIGHT = 1_080

const FILE_ROUTE = '/api/dsh-browser/file'

const PROXY_ROUTE = '/api/dsh-browser/proxy'

const PREVIEW_TOKEN_TTL_MS = 30 * 60 * 1_000
const MAX_PREVIEW_TOKENS = 256

/**
 * Normalize a user-supplied proxy server string into a form Chromium's
 * --proxy-server flag accepts. Pure numbers are treated as a local HTTP
 * proxy port; host:port without a scheme gets http:// prepended; schemes
 * http/https/socks4/socks5 pass through unchanged. Empty/invalid returns
 * undefined so the caller omits the flag entirely (system VPN / direct).
 */
export function normalizeProxyServer(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (/^\d+$/.test(trimmed)) return `http://127.0.0.1:${trimmed}`
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

interface FileTarget {
  root: string
  path: string
  previewToken?: string
}

/** Encode the workspace root into one URL-safe path segment. */
function rootToken(root: string): string {
  return Buffer.from(root, 'utf8').toString('base64url')
}

/** Encode a workspace-relative path while preserving its directory segments. */
function pathSegments(path: string): string {
  return path.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')
}

/** A directory URL whose ordinary relative references stay on the file route. */
function fileBaseUrl(root: string, directory: string, previewToken?: string, publicPathPrefix = ''): string {
  const encodedDirectory = pathSegments(directory)
  const fileRoute = `${publicPathPrefix}${FILE_ROUTE}`
  const prefix = previewToken === undefined
    ? `${fileRoute}/${rootToken(root)}`
    : `${fileRoute}/preview/${previewToken}/${rootToken(root)}`
  return `${prefix}/${encodedDirectory === '' ? '' : `${encodedDirectory}/`}`
}

/** Parse the legacy query form or the path form used by injected HTML bases. */
function fileTarget(url: URL): FileTarget | undefined {
  if (url.pathname === FILE_ROUTE) {
    const root = url.searchParams.get('root')
    const path = url.searchParams.get('path')
    return root === null || root === '' || path === null || path === '' ? undefined : { root, path }
  }
  if (!url.pathname.startsWith(`${FILE_ROUTE}/`)) return undefined
  const encoded = url.pathname.slice(FILE_ROUTE.length + 1)
  const segments = encoded.split('/')
  let previewToken: string | undefined
  let encodedRoot: string
  let encodedPath: string[]
  if (segments[0] === 'preview') {
    if (!isPreviewToken(segments[1] ?? null) || (segments[2] ?? '') === '' || segments.length < 4) return undefined
    previewToken = segments[1]
    encodedRoot = segments[2]
    encodedPath = segments.slice(3)
  } else {
    if ((segments[0] ?? '') === '' || segments.length < 2) return undefined
    encodedRoot = segments[0]
    encodedPath = segments.slice(1)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encodedRoot)) return undefined
  try {
    const root = Buffer.from(encodedRoot, 'base64url').toString('utf8')
    if (root === '' || rootToken(root) !== encodedRoot) return undefined
    const path = encodedPath.map(decodeURIComponent).join('/')
    return path === '' ? undefined : { root, path, previewToken }
  } catch {
    return undefined
  }
}

/**
 * The open-event broadcaster: agent tools push, GUI panels subscribe. Kept
 * deliberately tiny — one Set of response handles, one heartbeat timer.
 */
export class OpenBroadcaster {
  private subscribers = new Set<ServerResponse>()
  private heartbeat: NodeJS.Timeout | undefined

  /** Current subscriber count (the tools report whether a GUI is listening). */
  get count(): number {
    return this.subscribers.size
  }

  /** Push one event to every connected panel; returns how many received it. */
  push(event: BrowserEvent): number {
    let delivered = 0
    for (const res of this.subscribers) {
      res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
      delivered += 1
    }
    return delivered
  }

  /** Open one SSE stream for a loopback client. */
  subscribe(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    this.subscribers.add(res)
    this.ensureHeartbeat()
    req.on('close', () => {
      this.subscribers.delete(res)
      if (this.subscribers.size === 0) this.stopHeartbeat()
    })
  }

  /** Drop every stream (plugin teardown). */
  dispose(): void {
    this.stopHeartbeat()
    for (const res of this.subscribers) res.end()
    this.subscribers.clear()
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat !== undefined) return
    this.heartbeat = setInterval(() => {
      for (const res of this.subscribers) res.write(': ping\n\n')
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === undefined) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }
}

/** MIME map for the file route (everything else answers octet-stream). */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.apng': 'image/apng',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
}

/**
 * CSP for every served workspace document. Small HTML authorizes its own
 * scripts with one response nonce while the iframe remains on an opaque
 * origin; non-HTML documents stay inert.
 */
function documentCsp(nonce?: string): string {
  const sandbox = nonce === undefined ? 'sandbox' : 'sandbox allow-scripts'
  const scripts = nonce === undefined ? "'none'" : `'nonce-${nonce}' 'strict-dynamic' http: https:`
  const scriptAttributes = nonce === undefined ? "'none'" : "'unsafe-inline'"
  const connections = nonce === undefined ? "'none'" : 'http: https:'
  return `${sandbox}; default-src 'none'; img-src 'self' data: blob: http: https:; style-src 'self' 'unsafe-inline' http: https:; font-src 'self' data: http: https:; script-src ${scripts}; script-src-attr ${scriptAttributes}; connect-src ${connections}; media-src 'self' data: blob: http: https:`
}

/** Attach the response nonce to every page-authored script tag. */
function authorizePageScripts(html: string, nonce: string): string {
  return html.replace(/<script\b(?![^>]*\bnonce\s*=)/gi, `<script nonce="${nonce}"`)
}

/**
 * Render a friendly HTML error page when Puppeteer fails to load a URL.
 * Shown inside the panel iframe so the user sees what went wrong instead
 * of a blank page (the old behaviour returned a JSON 502 that iframes
 * render as empty).
 */
function renderErrorPage(url: string, message: string, proxy: string | undefined): string {
  const escapedUrl = url.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  const escapedMessage = message.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  const proxyLine = proxy !== undefined
    ? `<p class="hint">代理：<code>${proxy.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))}</code></p>`
    : '<p class="hint">未设置代理（直连 / 系统 VPN）</p>'
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>加载失败</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}.card{max-width:560px;width:100%;background:#16213e;border-radius:12px;padding:32px;box-shadow:0 8px 32px rgba(0,0,0,.4)}h1{margin:0 0 8px;font-size:20px;color:#ff6b6b}.url{font-size:13px;color:#8892b0;word-break:break-all;margin-bottom:16px}.msg{background:#0f3460;border-left:3px solid #ff6b6b;padding:12px 16px;border-radius:4px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}.hint{margin:16px 0 0;font-size:13px;color:#8892b0}code{background:#0f3460;padding:2px 6px;border-radius:3px;font-size:12px}.tips{margin-top:20px;padding-top:16px;border-top:1px solid #0f3460;font-size:13px;color:#8892b0;line-height:1.8}.tips b{color:#e0e0e0}</style></head>
<body><div class="card"><h1>页面加载失败</h1><div class="url">${escapedUrl}</div><div class="msg">${escapedMessage}</div>${proxyLine}
<div class="tips"><b>常见原因：</b><br>· 代理地址格式错误（应为 http://127.0.0.1:端口 或 socks5://127.0.0.1:端口）<br>· 代理客户端未启动或端口不对<br>· 使用系统 VPN（TUN/全局）时应留空代理设置<br>· 目标网站不可达或超时</div></div></body></html>`
}

/**
 * Proxy handler: renders the target URL with a headless Chromium (Puppeteer)
 * so JavaScript-executed pages load correctly, strips the embedding
 * restriction headers, injects a <base> so relative resources resolve
 * against the original origin, and returns the executed HTML to the panel
 * iframe. The browser instance is shared and lazily launched; proxy settings
 * are passed through Chromium's --proxy-server flag.
 */
async function handleProxy(
  req: IncomingMessage,
  res: ServerResponse,
  browserOptions: BrowserOptions,
): Promise<void> {
  if (!isLoopbackRequest(req)) {
    forbidden(res)
    return
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' })
    res.end(JSON.stringify({ error: 'proxy only supports GET requests' }))
    return
  }
  const url = new URL(req.url ?? '/', 'http://x')
  const target = url.searchParams.get('url')
  if (target === null || target === '') {
    json(res, FAIL(BAD_REQUEST), 400)
    return
  }

  let rendered: { html: string; finalUrl: string }
  try {
    rendered = await renderUrl(target, browserOptions)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const body = renderErrorPage(target, message, browserOptions.proxyServer)
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(body)
    return
  }

  // Inject <base> so relative resources load from the original origin
  // instead of the proxy URL. Puppeteer already executed the page's JS,
  // so the returned HTML is the fully-rendered DOM.
  let html = rendered.html
  let baseUrl: string
  try {
    const parsed = new URL(rendered.finalUrl)
    baseUrl = parsed.origin + parsed.pathname.replace(/[^/]*$/, '')
  } catch {
    baseUrl = rendered.finalUrl.replace(/[^/]*$/, '')
  }
  const baseTag = `<base href="${baseUrl}">`
  // Intercept _blank links and window.open() so navigation stays inside the
  // panel instead of popping the system browser. _blank / window.open opens
  // a new tab; ordinary links navigate the current tab. The parent window
  // listens for these messages and routes them through the proxy.
  const navInterceptor = `<script>(function(){var _o=window.open;window.open=function(u){if(u&&u!==''&&u!=='about:blank'){window.parent.postMessage({source:'dsh-browser',kind:'open',url:String(u)},'*');return null;}return _o.apply(this,arguments);};document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(a&&a.href&&/^https?:/i.test(a.href)){e.preventDefault();var t=(a.target||'').toLowerCase();var kind=(t==='_blank'||t==='_new')?'open':'navigate';window.parent.postMessage({source:'dsh-browser',kind:kind,url:a.href},'*');}},true);})();</script>`
  const headInject = `${/<base\s/i.test(html) ? '' : baseTag}${navInterceptor}`
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, match => match + headInject)
    : headInject + html

  const body = Buffer.from(html, 'utf8')
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'content-length': body.length.toString(),
    // No response CSP / X-Frame-Options — the panel applies an iframe sandbox
    // without allow-same-origin, so rendered scripts cannot reach GUI APIs.
  })
  res.end(body)
}

/**
 * Register the route family on the shared webserver.
 * @param ctx - context carrying the webServer service.
 * @param gate - the workspace gate every fs route runs through.
 * @param broadcaster - the open-event broadcaster shared with the agent tools.
 * @param browserOptions - Puppeteer launch options (executable path, proxy server, private access).
 * @returns disposer removing every route and closing the shared browser.
 */
export function registerBrowserRoutes(
  ctx: Context,
  gate: WorkspaceGate,
  broadcaster: OpenBroadcaster,
  browserOptions: BrowserOptions = {},
  reviewStore?: ReviewStore,
  updates?: UpdateService,
): () => void {
  const previewTokens = new Map<string, { root: string; expiresAt: number }>()

  const prunePreviewTokens = (): void => {
    const now = Date.now()
    for (const [token, entry] of previewTokens) {
      if (entry.expiresAt <= now) previewTokens.delete(token)
    }
    while (previewTokens.size > MAX_PREVIEW_TOKENS) {
      const oldest = previewTokens.keys().next().value as string | undefined
      if (oldest === undefined) break
      previewTokens.delete(oldest)
    }
  }

  const rememberPreviewToken = (token: string, root: string): void => {
    prunePreviewTokens()
    previewTokens.delete(token)
    previewTokens.set(token, { root, expiresAt: Date.now() + PREVIEW_TOKEN_TTL_MS })
  }

  const acceptPreviewToken = (token: string, root: string): boolean => {
    const entry = previewTokens.get(token)
    if (entry === undefined || entry.root !== root || entry.expiresAt <= Date.now()) {
      previewTokens.delete(token)
      return false
    }
    entry.expiresAt = Date.now() + PREVIEW_TOKEN_TTL_MS
    return true
  }

  const handleList = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      forbidden(res)
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const root = url.searchParams.get('root')
    const path = url.searchParams.get('path') ?? ''
    if (root === null || root === '') {
      json(res, FAIL(BAD_REQUEST), 400)
      return
    }
    const gated = await gate(root)
    if (!gated.ok) {
      json(res, FAIL(gated.error), 400)
      return
    }
    const resolved = await resolveInside(gated.canonical, root, path)
    if (!resolved.ok) {
      json(res, FAIL(resolved.error), resolved.error.code === 'not-found' ? 404 : 403)
      return
    }
    let dirents
    try {
      dirents = await readdir(resolved.canonical, { withFileTypes: true })
    } catch {
      json(res, FAIL({ code: 'not-found', message: 'cannot read directory' }), 404)
      return
    }
    const entries = dirents
      .map(dirent => ({
        name: dirent.name,
        kind: dirent.isDirectory() ? 'dir' as const : dirent.isFile() ? 'file' as const : 'other' as const,
        size: undefined,
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1
      })
    const value: WorkspaceListing = { root: gated.canonical, path, entries }
    json(res, OK(value))
  }

  const handleFile = async (req: IncomingMessage, res: ServerResponse, publicPathPrefix = ''): Promise<void> => {
    const trustedRequest = isLoopbackRequest(req)
    const opaqueResourceRequest = !trustedRequest && isLoopbackPreviewResourceRequest(req)
    if (!trustedRequest && !opaqueResourceRequest) {
      forbidden(res)
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const target = fileTarget(url)
    if (target === undefined) {
      json(res, FAIL(BAD_REQUEST), 400)
      return
    }
    const { root, path } = target
    const tokenValue = url.searchParams.get('reviewToken')
    const queryReviewToken = isPreviewToken(tokenValue) ? tokenValue : undefined
    if (opaqueResourceRequest && (target.previewToken === undefined || !acceptPreviewToken(target.previewToken, root))) {
      forbidden(res)
      return
    }
    const gated = await gate(root)
    if (!gated.ok) {
      json(res, FAIL(gated.error), 400)
      return
    }
    if (trustedRequest && queryReviewToken !== undefined) {
      rememberPreviewToken(queryReviewToken, gated.canonical)
    }
    const reviewToken = queryReviewToken ?? target.previewToken
    const resolved = await resolveInside(gated.canonical, root, path)
    if (!resolved.ok) {
      json(res, FAIL(resolved.error), resolved.error.code === 'not-found' ? 404 : 403)
      return
    }
    let file
    try {
      file = await open(resolved.canonical, 'r')
    } catch {
      json(res, FAIL({ code: 'not-found', message: 'cannot open file' }), 404)
      return
    }
    try {
      const info = await file.stat()
      if (!info.isFile()) {
        json(res, FAIL({ code: 'is-directory', message: 'path is a directory' }), 400)
        return
      }
      if (info.size > MAX_FILE_BYTES) {
        json(res, FAIL({ code: 'too-large', message: 'file exceeds the size limit' }), 400)
        return
      }
      const ext = extname(path).toLowerCase()
      const mime = MIME[ext] ?? 'application/octet-stream'
      const baseHeaders: Record<string, string | number> = {
        'content-type': mime,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-length': info.size,
        'content-security-policy': documentCsp(),
      }
      const isHtml = mime.startsWith('text/html')
      if (isHtml && info.size <= MAX_BASE_INJECT_BYTES) {
        // Small HTML gets a capability-carrying <base> so relative assets can
        // load from an opaque iframe without opening general cross-site fetch.
        let html = await file.readFile('utf8')
        const dirRel = path.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
        const baseUrl = fileBaseUrl(gated.canonical, dirRel, reviewToken, publicPathPrefix)
        const nonce = randomUUID().replaceAll('-', '')
        const inject = `<base href="${baseUrl}">${reviewBridgeScript(reviewToken, nonce)}`
        html = authorizePageScripts(html, nonce)
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => `${match}${inject}`) : inject + html
        const body = Buffer.from(html, 'utf8')
        res.writeHead(200, {
          ...baseHeaders,
          'content-length': body.length,
          'content-security-policy': documentCsp(nonce),
        })
        res.end(body)
        return
      }
      res.writeHead(200, baseHeaders)
      await pipeline(file.createReadStream({ autoClose: false }), res)
    } finally {
      await file.close()
    }
  }

  const handleScreenshot = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      forbidden(res)
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' })
      res.end(JSON.stringify({ error: 'screenshot only supports GET requests' }))
      return
    }
    const requestUrl = new URL(req.url ?? '/', 'http://x')
    const root = requestUrl.searchParams.get('root') ?? ''
    const rawTarget = requestUrl.searchParams.get('url') ?? ''
    const width = Number(requestUrl.searchParams.get('width'))
    const height = Number(requestUrl.searchParams.get('height'))
    if (root === '' || rawTarget === '' || !Number.isInteger(width) || !Number.isInteger(height)
      || width < MIN_CAPTURE_WIDTH || width > MAX_CAPTURE_WIDTH
      || height < MIN_CAPTURE_HEIGHT || height > MAX_CAPTURE_HEIGHT) {
      json(res, FAIL(BAD_REQUEST), 400)
      return
    }
    const gated = await gate(root)
    if (!gated.ok) {
      json(res, FAIL(gated.error), 400)
      return
    }
    const host = req.headers.host
    if (typeof host !== 'string') {
      json(res, FAIL(BAD_REQUEST), 400)
      return
    }
    const localOrigin = `http://${host}`
    let target: URL
    try {
      target = new URL(rawTarget, localOrigin)
    } catch {
      json(res, FAIL(BAD_REQUEST), 400)
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      json(res, FAIL(BAD_REQUEST), 400)
      return
    }
    if (target.origin === localOrigin) {
      if (target.pathname !== FILE_ROUTE) {
        json(res, FAIL(BAD_REQUEST), 400)
        return
      }
      const targetRoot = target.searchParams.get('root') ?? ''
      const targetGate = await gate(targetRoot)
      if (!targetGate.ok || targetGate.canonical !== gated.canonical) {
        json(res, FAIL({ code: 'workspace-unknown', message: 'screenshot target is outside the workspace' }), 400)
        return
      }
      target.searchParams.set('reviewToken', randomUUID().replaceAll('-', ''))
    }
    try {
      const image = await captureUrl(target.toString(), browserOptions, { width, height })
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': image.byteLength,
        'x-content-type-options': 'nosniff',
      })
      res.end(image)
    } catch {
      json(res, FAIL({ code: 'internal', message: 'failed to capture the review page' }), 502)
    }
  }

  const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isLoopbackRequest(req)) {
      forbidden(res)
      return
    }
    broadcaster.subscribe(req, res)
  }

  const previewServer = createLoopbackPreviewServer(async (req, res, publicPathPrefix) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === PROXY_ROUTE) {
      await safely((request, response) => handleProxy(request, response, browserOptions), req, res)
      return
    }
    if (url.pathname === FILE_ROUTE || url.pathname.startsWith(`${FILE_ROUTE}/`)) {
      await safely((request, response) => handleFile(request, response, publicPathPrefix), req, res)
      return
    }
    res.writeHead(404, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
    res.end('not found')
  })

  const handlePreviewSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      forbidden(res)
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' })
      res.end(JSON.stringify({ error: 'preview session only supports GET requests' }))
      return
    }
    const value = await previewServer.session()
    const body = Buffer.from(JSON.stringify(OK(value)), 'utf8')
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  const disposers: Array<() => void> = []
  try {
    // Exact routes must register before the prefix route — otherwise the
    // prefix /api/dsh-browser catches /proxy and /events first and 404s.
    disposers.push(ctx.webServer.register({ kind: 'exact', path: PROXY_ROUTE, handler: (req, res) => safely((r, s) => handleProxy(r, s, browserOptions), req, res) }))
    disposers.push(ctx.webServer.register({ kind: 'exact', path: '/api/dsh-browser/events', handler: (req, res) => safely(handleEvents, req, res) }))
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: '/api/dsh-browser', handler: (req, res) => safely(async () => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (updates !== undefined && (url.pathname === '/api/dsh-browser/updates' || url.pathname === '/api/dsh-browser/updates/check')) {
        await handleUpdateRoute(req, res, updates)
        return
      }
      if (url.pathname === '/api/dsh-browser/list') {
        await handleList(req, res)
        return
      }
      if (url.pathname === PREVIEW_SESSION_ROUTE) {
        await handlePreviewSession(req, res)
        return
      }
      if (url.pathname === FILE_ROUTE || url.pathname.startsWith(`${FILE_ROUTE}/`)) {
        await handleFile(req, res)
        return
      }
      if (url.pathname === SCREENSHOT_ROUTE) {
        await handleScreenshot(req, res)
        return
      }
      if (reviewStore !== undefined && (
        url.pathname === '/api/dsh-browser/comments'
        || url.pathname === '/api/dsh-browser/comments/resolve'
        || url.pathname === '/api/dsh-browser/review-batches'
        || url.pathname === '/api/dsh-browser/review-batches/reopen'
      )) {
        await handleReviewRoute(req, res, gate, reviewStore)
        return
      }
      if (url.pathname === '/api/dsh-browser/source') {
        await handleSourceRoute(req, res, gate)
        return
      }
      res.writeHead(404)
      res.end()
    }, req, res) }))
  } catch (error) {
    previewServer.close()
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
    broadcaster.dispose()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
    previewTokens.clear()
    previewServer.close()
    broadcaster.dispose()
    void closeBrowser()
  }
}
