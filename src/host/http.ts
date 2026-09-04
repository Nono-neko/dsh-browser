/** Shared loopback HTTP guards and response helpers for Host routes. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BrowserEnvelope, BrowserError } from '../core/types.ts'

const INTERNAL_ERROR: BrowserError = { code: 'internal', message: 'internal server error' }

/** Maximum JSON request body accepted by review mutations. */
const MAX_JSON_BODY_BYTES = 256 * 1024

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const SAFE_OPAQUE_DESTINATIONS = new Set([
  'audio',
  'font',
  'iframe',
  'image',
  'manifest',
  'script',
  'style',
  'track',
  'video',
  'worker',
])

/** Bounded URL-safe capability minted by the Client for one preview frame. */
export function isPreviewToken(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

function loopbackHostUrl(request: IncomingMessage): URL | undefined {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return undefined
  const host = request.headers.host
  if (typeof host !== 'string') return undefined
  try {
    const value = new URL(`http://${host}`)
    return LOOPBACK_HOSTS.has(value.hostname) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Loopback trust fence: socket address and Host must both be loopback, while
 * browser origin markers must be same-origin. Forwarded headers are ignored.
 */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  const hostUrl = loopbackHostUrl(request)
  if (hostUrl === undefined) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Identify opaque-origin preview subresources without opening script fetches.
 * The file route additionally requires a host-registered capability token.
 */
export function isLoopbackPreviewResourceRequest(
  request: IncomingMessage,
): boolean {
  const hostUrl = loopbackHostUrl(request)
  if (hostUrl === undefined || request.method !== 'GET') return false
  if (request.headers['sec-fetch-site'] !== 'cross-site') return false
  const destination = request.headers['sec-fetch-dest']
  return typeof destination === 'string' && SAFE_OPAQUE_DESTINATIONS.has(destination)
}

export function forbidden(res: ServerResponse): void {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'forbidden: loopback-only' }))
}

export function json(res: ServerResponse, envelope: BrowserEnvelope<unknown>, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/** Keep unexpected failures inside the stable BrowserEnvelope contract. */
export async function safely(
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
    json(res, { ok: false, error: INTERNAL_ERROR }, 500)
  }
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: BrowserError; status: number }

/** Read one bounded UTF-8 JSON body without trusting content-length. */
export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<JsonBodyResult> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > maxBytes) {
        return {
          ok: false,
          error: { code: 'too-large', message: 'JSON request body exceeds the size limit' },
          status: 413,
        }
      }
      chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, error: { code: 'bad-request', message: 'invalid JSON request body' }, status: 400 }
  }
}
