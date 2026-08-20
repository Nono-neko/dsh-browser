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

import { open, readdir, realpath } from 'node:fs/promises'
import { extname, resolve as resolvePath } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { BrowserEnvelope, BrowserEvent, BrowserError, WorkspaceListing } from '../core/types.ts'
import { fetchGuarded } from './tools.ts'
import { isPathInside, type WorkspaceGate } from './gate.ts'

const OK = <T>(value: T): BrowserEnvelope<T> => ({ ok: true, value })
const FAIL = (error: BrowserError): BrowserEnvelope<never> => ({ ok: false, error })
const BAD_REQUEST: BrowserError = { code: 'bad-request', message: 'malformed request' }
const INTERNAL_ERROR: BrowserError = { code: 'internal', message: 'internal server error' }

/** SSE keep-alive interval (proxies drop idle connections). */
const HEARTBEAT_MS = 15_000

/** Maximum file size served through the file route (larger answers too-large). */
const MAX_FILE_BYTES = 64 * 1024 * 1024

/** Maximum HTML size that gets a <base> injection (larger is streamed as-is). */
const MAX_BASE_INJECT_BYTES = 8 * 1024 * 1024

const FILE_ROUTE = '/api/dsh-browser/file'

const PROXY_ROUTE = '/api/dsh-browser/proxy'

interface FileTarget {
  root: string
  path: string
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
function fileBaseUrl(root: string, directory: string): string {
  const encodedDirectory = pathSegments(directory)
  return `${FILE_ROUTE}/${rootToken(root)}/${encodedDirectory === '' ? '' : `${encodedDirectory}/`}`
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
  const separator = encoded.indexOf('/')
  if (separator <= 0 || separator === encoded.length - 1) return undefined
  const encodedRoot = encoded.slice(0, separator)
  if (!/^[A-Za-z0-9_-]+$/.test(encodedRoot)) return undefined
  try {
    const root = Buffer.from(encodedRoot, 'base64url').toString('utf8')
    if (root === '' || rootToken(root) !== encodedRoot) return undefined
    const path = encoded.slice(separator + 1).split('/').map(decodeURIComponent).join('/')
    return path === '' ? undefined : { root, path }
  } catch {
    return undefined
  }
}

/**
 * Loopback trust fence: a loopback socket address AND a loopback Host header,
 * plus browser same-origin markers. The socket address is authoritative;
 * X-Forwarded-For is never trusted (matching dsh-ssh).
 */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Write the shared non-loopback rejection. */
function forbidden(res: ServerResponse): void {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'forbidden: loopback-only' }))
}

function json(res: ServerResponse, envelope: BrowserEnvelope<unknown>, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/** Keep unexpected handler failures inside the route's stable JSON contract. */
async function safely(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await handler(req, res)
  } catch {
    if (res.headersSent || res.writableEnded || res.destroyed) {
      res.destroy()
      return
    }
    json(res, FAIL(INTERNAL_ERROR), 500)
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
  '.pdf': 'application/pdf',
}

/**
 * CSP for every served workspace document. Applying it uniformly also covers
 * active non-HTML formats such as SVG and XML when they are loaded in a frame.
 */
const DOCUMENT_CSP = "sandbox; default-src 'none'; img-src data: blob: http: https:; style-src 'unsafe-inline' http: https:; media-src data: blob: http: https:"

/** Resolve and verify a root-relative path against the gated workspace root. */
async function resolveInside(canonicalRoot: string, root: string, rel: string): Promise<
  { ok: true; abs: string; canonical: string }
  | { ok: false; error: BrowserError }
> {
  const joined = resolvePath(root, rel === '' ? '.' : rel)
  let canonical: string
  try {
    canonical = await realpath(joined)
  } catch {
    return { ok: false, error: { code: 'not-found', message: 'path does not resolve on disk' } }
  }
  if (!isPathInside(canonicalRoot, canonical)) {
    return { ok: false, error: { code: 'path-outside-root', message: 'path escapes the workspace root' } }
  }
  return { ok: true, abs: joined, canonical }
}

/**
 * Proxy handler: fetches the target URL through the host (with the SSRF
 * guard applied to every hop), strips X-Frame-Options and CSP frame-ancestors
 * so the page can render in the panel iframe, injects a <base> into HTML so
 * relative resources resolve against the original origin, and streams the body
 * back to the client. Only GET is supported (form posts / uploads are out of
 * scope for the embedded viewer).
 */
async function handleProxy(
  req: IncomingMessage,
  res: ServerResponse,
  allowPrivate: boolean,
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

  const outcome = await fetchGuarded(target, allowPrivate)
  if (!outcome.ok) {
    json(res, FAIL({ code: 'bad-request', message: outcome.error }), 400)
    return
  }

  const { res: upstream, finalUrl } = outcome

  // Strip the embedding-restriction headers; everything else passes through.
  const headers = new Headers(upstream.headers)
  headers.delete('x-frame-options')
  headers.delete('content-security-policy')
  headers.delete('content-security-policy-report-only')

  const contentType = headers.get('content-type') ?? ''
  const contentLength = headers.get('content-length')
  const size = contentLength !== null ? Number(contentLength) : Infinity

  // Small HTML gets a <base> so relative images/styles/scripts resolve
  // against the original origin instead of the proxy URL.
  if (/text\/html/i.test(contentType) && size <= MAX_BASE_INJECT_BYTES) {
    let html = await upstream.text()
    let baseUrl: string
    try {
      const parsed = new URL(finalUrl)
      baseUrl = parsed.origin + parsed.pathname.replace(/[^/]*$/, '')
    } catch {
      baseUrl = finalUrl.replace(/[^/]*$/, '')
    }
    const baseTag = `<base href="${baseUrl}">`
    if (!/<base\s/i.test(html)) {
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, match => match + baseTag)
        : baseTag + html
    }
    const body = Buffer.from(html, 'utf8')
    headers.set('content-length', body.length.toString())
    res.writeHead(upstream.status, Object.fromEntries(headers.entries()))
    res.end(body)
    return
  }

  // Stream everything else straight through.
  res.writeHead(upstream.status, Object.fromEntries(headers.entries()))
  if (upstream.body !== null) {
    const reader = upstream.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) res.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  res.end()
}

/**
 * Register the route family on the shared webserver.
 * @param ctx - context carrying the webServer service.
 * @param gate - the workspace gate every fs route runs through.
 * @param broadcaster - the open-event broadcaster shared with the agent tools.
 * @param allowPrivate - when true, the proxy may fetch private-range addresses (SSRF override).
 * @returns disposer removing every route.
 */
export function registerBrowserRoutes(
  ctx: Context,
  gate: WorkspaceGate,
  broadcaster: OpenBroadcaster,
  allowPrivate = false,
): () => void {
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

  const handleFile = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
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
        'content-security-policy': DOCUMENT_CSP,
      }
      const isHtml = mime.startsWith('text/html')
      if (isHtml && info.size <= MAX_BASE_INJECT_BYTES) {
        // Small HTML gets a <base> pointing at its own directory so relative
        // images/styles resolve through this route; scripts stay blocked by CSP.
        let html = await file.readFile('utf8')
        const dirRel = path.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
        const baseUrl = fileBaseUrl(gated.canonical, dirRel)
        const tag = `<base href="${baseUrl}">`
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => `${match}${tag}`) : tag + html
        const body = Buffer.from(html, 'utf8')
        res.writeHead(200, { ...baseHeaders, 'content-length': body.length })
        res.end(body)
        return
      }
      res.writeHead(200, baseHeaders)
      await pipeline(file.createReadStream({ autoClose: false }), res)
    } finally {
      await file.close()
    }
  }

  const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isLoopbackRequest(req)) {
      forbidden(res)
      return
    }
    broadcaster.subscribe(req, res)
  }

  const disposers: Array<() => void> = []
  try {
    // Exact routes must register before the prefix route — otherwise the
    // prefix /api/dsh-browser catches /proxy and /events first and 404s.
    disposers.push(ctx.webServer.register({ kind: 'exact', path: PROXY_ROUTE, handler: (req, res) => safely((r, s) => handleProxy(r, s, allowPrivate), req, res) }))
    disposers.push(ctx.webServer.register({ kind: 'exact', path: '/api/dsh-browser/events', handler: (req, res) => safely(handleEvents, req, res) }))
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: '/api/dsh-browser', handler: (req, res) => safely(async () => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/api/dsh-browser/list') {
        await handleList(req, res)
        return
      }
      if (url.pathname === FILE_ROUTE || url.pathname.startsWith(`${FILE_ROUTE}/`)) {
        await handleFile(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    }, req, res) }))
  } catch (error) {
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
    broadcaster.dispose()
  }
}
