/** Isolated loopback carrier for sandboxed Desktop iframe documents. */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserPreviewSession } from '../core/types.ts'

const PREVIEW_PREFIX = '/_dsh-browser-preview'

export type PreviewRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  publicPathPrefix: string,
) => void | Promise<void>

export interface LoopbackPreviewServer {
  session(): Promise<BrowserPreviewSession>
  close(): void
}

function reject(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/**
 * Start lazily so ordinary web clients retain the shared DSH carrier. Desktop
 * iframe requests use a separate random-path listener because Desktop keeps
 * its native renderer capability out of opaque sandbox frames.
 */
export function createLoopbackPreviewServer(handler: PreviewRequestHandler): LoopbackPreviewServer {
  const capability = randomBytes(32).toString('base64url')
  const publicPathPrefix = `${PREVIEW_PREFIX}/${capability}`
  let server: Server | undefined
  let ready: Promise<BrowserPreviewSession> | undefined
  let closed = false

  const start = (): Promise<BrowserPreviewSession> => {
    if (closed) return Promise.reject(new Error('preview carrier is closed'))
    if (ready !== undefined) return ready
    server = createServer((req, res) => {
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('cross-origin-resource-policy', 'cross-origin')
      res.setHeader('access-control-allow-origin', '*')
      if (req.method !== 'GET') {
        reject(res, 405, 'method not allowed')
        return
      }
      let requestUrl: URL
      try {
        requestUrl = new URL(req.url ?? '/', 'http://dsh-browser.invalid')
      } catch {
        reject(res, 400, 'bad request')
        return
      }
      if (!requestUrl.pathname.startsWith(`${publicPathPrefix}/`)) {
        reject(res, 403, 'forbidden')
        return
      }
      const innerPath = requestUrl.pathname.slice(publicPathPrefix.length)
      req.url = `${innerPath}${requestUrl.search}`
      Promise.resolve(handler(req, res, publicPathPrefix)).catch(() => {
        if (res.headersSent || res.writableEnded || res.destroyed) {
          res.destroy()
          return
        }
        reject(res, 500, 'internal server error')
      })
    })
    server.on('clientError', (_error, socket) => { socket.destroy() })
    ready = new Promise<BrowserPreviewSession>((resolve, rejectReady) => {
      const activeServer = server as Server
      const onError = (error: Error): void => {
        activeServer.off('listening', onListening)
        rejectReady(error)
      }
      const onListening = (): void => {
        activeServer.off('error', onError)
        const address = activeServer.address() as AddressInfo | null
        if (address === null || typeof address === 'string') {
          rejectReady(new Error('preview carrier has no loopback port'))
          return
        }
        resolve({ baseUrl: `http://127.0.0.1:${String(address.port)}${publicPathPrefix}` })
      }
      activeServer.once('error', onError)
      activeServer.once('listening', onListening)
      activeServer.listen(0, '127.0.0.1')
      activeServer.unref()
    })
    return ready
  }

  return {
    session: start,
    close() {
      if (closed) return
      closed = true
      if (server === undefined) return
      const activeServer = server
      const shutdown = (): void => {
        try { activeServer.close() } catch {}
        activeServer.closeAllConnections()
      }
      if (activeServer.listening) shutdown()
      else activeServer.once('listening', shutdown)
    },
  }
}
