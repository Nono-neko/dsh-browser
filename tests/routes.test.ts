import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/host/browser-pool.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/host/browser-pool.ts')>()
  return { ...original, captureUrl: vi.fn(async () => Buffer.from([1, 2, 3])) }
})

import { captureUrl } from '../src/host/browser-pool.ts'
import { OpenBroadcaster, registerBrowserRoutes } from '../src/host/routes.ts'
import type { WorkspaceGate } from '../src/host/gate.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface RouteRegistration {
  kind: 'prefix' | 'exact'
  path: string
  handler: RouteHandler
}

class CapturedResponse extends Writable {
  status = 0
  readonly headers: Record<string, string | number> = {}
  private readonly chunks: Buffer[] = []

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.status = status
    for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value
    return this
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks)
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    callback()
  }
}

class SlowResponse extends CapturedResponse {
  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.emit('chunk')
    setTimeout(() => { super._write(chunk, encoding, callback) }, 5)
  }
}

function request(url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as EventEmitter & {
    method: string
    url: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  req.method = 'GET'
  req.url = url
  req.headers = { host: 'localhost:3000', origin: 'http://localhost:3000', ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req as unknown as IncomingMessage
}

function routeHarness(gate: WorkspaceGate): {
  file: (url: string, headers?: Record<string, string>) => Promise<CapturedResponse>
  dispatch: (url: string, response: CapturedResponse, headers?: Record<string, string>) => {
    request: IncomingMessage
    completion: Promise<void>
  }
  dispose: () => void
} {
  const registrations: RouteRegistration[] = []
  const ctx = {
    webServer: {
      register(registration: RouteRegistration) {
        registrations.push(registration)
        return () => {
          const index = registrations.indexOf(registration)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
  } as unknown as Context
  const dispose = registerBrowserRoutes(ctx, gate, new OpenBroadcaster())
  const prefix = registrations.find(registration => registration.kind === 'prefix')
  if (prefix === undefined) throw new Error('prefix route was not registered')
  const dispatch = (url: string, response: CapturedResponse, headers: Record<string, string> = {}) => {
    const req = request(url, headers)
    const completion = Promise.resolve(prefix.handler(req, response as unknown as ServerResponse))
    return { request: req, completion }
  }
  return {
    async file(url, headers = {}) {
      const res = new CapturedResponse()
      await dispatch(url, res, headers).completion
      if (!res.writableFinished && !res.destroyed) await once(res, 'finish')
      return res
    },
    dispatch,
    dispose,
  }
}

describe('registerBrowserRoutes', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-browser-routes-')))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('sandboxes an SVG workspace document', async () => {
    await writeFile(join(root, 'active.svg'), '<svg><script>alert(1)</script></svg>')
    const gate: WorkspaceGate = async () => ({ ok: true, canonical: root })
    const routes = routeHarness(gate)

    const url = `/api/dsh-browser/file?root=${encodeURIComponent(root)}&path=active.svg`
    const response = await routes.file(url)
    routes.dispose()

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('image/svg+xml')
    expect(response.headers['content-security-policy']).toContain('sandbox')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.headers['content-security-policy']).toContain("script-src 'none'")
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'")
  })

  it('resolves HTML relative assets through a path-style base while legacy query URLs still work', async () => {
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'index.html'), '<html><head></head><body><img src="asset.txt"></body></html>')
    await writeFile(join(root, 'docs', 'asset.txt'), 'asset body')
    const gate: WorkspaceGate = async () => ({ ok: true, canonical: root })
    const routes = routeHarness(gate)

    const legacyHtmlUrl = `/api/dsh-browser/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent('docs/index.html')}`
    const htmlResponse = await routes.file(legacyHtmlUrl)
    const baseHref = /<base href="([^"]+)">/.exec(htmlResponse.body.toString('utf8'))?.[1]
    expect(baseHref).toMatch(/^\/api\/dsh-browser\/file\/[A-Za-z0-9_-]+\/docs\/$/)

    const assetUrl = new URL('asset.txt', new URL(baseHref as string, 'http://localhost:3000'))
    const pathResponse = await routes.file(assetUrl.pathname)
    expect(pathResponse.status).toBe(200)
    expect(pathResponse.body.toString('utf8')).toBe('asset body')

    const legacyAssetUrl = `/api/dsh-browser/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent('docs/asset.txt')}`
    const legacyResponse = await routes.file(legacyAssetUrl)
    routes.dispose()
    expect(legacyResponse.status).toBe(200)
    expect(legacyResponse.body.toString('utf8')).toBe('asset body')
  })

  it('injects one response nonce and the live-review bridge into workspace HTML', async () => {
    await writeFile(join(root, 'preview.html'), '<html><head><script>window.pageScript = true</script></head><body><main>Preview</main></body></html>')
    const gate: WorkspaceGate = async () => ({ ok: true, canonical: root })
    const routes = routeHarness(gate)
    const token = 'abcDEF0123456789'

    const url = `/api/dsh-browser/file?root=${encodeURIComponent(root)}&path=preview.html&reviewToken=${token}`
    const response = await routes.file(url)
    routes.dispose()

    const csp = String(response.headers['content-security-policy'])
    const nonce = /script-src 'nonce-([a-f0-9]{32})'/.exec(csp)?.[1]
    const html = response.body.toString('utf8')
    expect(response.status).toBe(200)
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).toContain('connect-src http: https:')
    expect(nonce).toBeTypeOf('string')
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).toContain(`data-dsh-browser-review data-review-token="${token}"`)
    expect(html).toContain(`nonce="${nonce}" data-dsh-browser-review`)
    expect(html).toContain("send('review-pick'")
    expect(html).toContain("send('review-scroll'")
    expect(html).toContain(`<script nonce="${nonce}">window.pageScript = true</script>`)
  })

  it('allows opaque-origin preview subresources but rejects script fetches', async () => {
    await writeFile(join(root, 'index.html'), '<link rel="stylesheet" href="style.css">')
    await writeFile(join(root, 'style.css'), 'body { color: teal; }')
    const gate: WorkspaceGate = async () => ({ ok: true, canonical: root })
    const routes = routeHarness(gate)
    const htmlUrl = `/api/dsh-browser/file?root=${encodeURIComponent(root)}&path=index.html&reviewToken=abcDEF0123456789`
    const htmlResponse = await routes.file(htmlUrl)
    const baseHref = /<base href="([^"]+)">/.exec(htmlResponse.body.toString('utf8'))?.[1]
    const styleUrl = new URL('style.css', new URL(baseHref as string, 'http://localhost:3000'))
    const referer = `http://localhost:3000${htmlUrl}`
    const opaqueHeaders = {
      origin: 'null',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-dest': 'style',
      referer,
    }

    const styleResponse = await routes.file(styleUrl.pathname, opaqueHeaders)
    const fetchResponse = await routes.file(styleUrl.pathname, {
      ...opaqueHeaders,
      'sec-fetch-dest': 'empty',
    })
    const invalidTokenUrl = styleUrl.pathname.replace('abcDEF0123456789', 'otherTOKEN0123456')
    const externalResponse = await routes.file(invalidTokenUrl, {
      ...opaqueHeaders,
      referer: 'https://example.com/page',
    })
    routes.dispose()

    expect(styleResponse.status).toBe(200)
    expect(styleResponse.body.toString('utf8')).toContain('color: teal')
    expect(fetchResponse.status).toBe(403)
    expect(externalResponse.status).toBe(403)
  })

  it('captures a workspace page only after re-checking its root', async () => {
    await writeFile(join(root, 'index.html'), '<html><body>Preview</body></html>')
    const gate: WorkspaceGate = async value => value === root
      ? { ok: true, canonical: root }
      : { ok: false, error: { code: 'workspace-unknown', message: 'unknown workspace' } }
    const routes = routeHarness(gate)
    const target = `/api/dsh-browser/file?root=${encodeURIComponent(root)}&path=index.html`
    const capture = `/api/dsh-browser/screenshot?root=${encodeURIComponent(root)}&url=${encodeURIComponent(target)}&width=800&height=600`

    const response = await routes.file(capture)

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('image/png')
    expect([...response.body]).toEqual([1, 2, 3])
    expect(vi.mocked(captureUrl)).toHaveBeenCalledWith(
      expect.stringContaining('reviewToken='),
      {},
      { width: 800, height: 600 },
    )

    const outsideTarget = '/api/dsh-browser/file?root=C%3A%2Foutside&path=index.html'
    const rejected = await routes.file(`/api/dsh-browser/screenshot?root=${encodeURIComponent(root)}&url=${encodeURIComponent(outsideTarget)}&width=800&height=600`)
    const crossSite = await routes.file(capture, {
      origin: 'https://example.com',
      'sec-fetch-site': 'cross-site',
    })
    routes.dispose()
    expect(rejected.status).toBe(400)
    expect(rejected.body.toString('utf8')).toContain('outside the workspace')
    expect(crossSite.status).toBe(403)
  })

  it('turns an unexpected route failure into an internal error envelope', async () => {
    const gate: WorkspaceGate = async () => { throw new Error('sensitive failure detail') }
    const routes = routeHarness(gate)

    const url = `/api/dsh-browser/file?root=${encodeURIComponent(root)}&path=file.txt`
    const response = await routes.file(url)
    routes.dispose()

    expect(response.status).toBe(500)
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      ok: false,
      error: { code: 'internal', message: 'internal server error' },
    })
    expect(response.body.toString('utf8')).not.toContain('sensitive failure detail')
  })

  it('stops a file response when the client connection closes', async () => {
    const size = 4 * 1024 * 1024
    await writeFile(join(root, 'large.bin'), Buffer.alloc(size, 0x61))
    const gate: WorkspaceGate = async () => ({ ok: true, canonical: root })
    const routes = routeHarness(gate)
    const response = new SlowResponse()
    const url = `/api/dsh-browser/file?root=${encodeURIComponent(root)}&path=large.bin`

    const dispatched = routes.dispatch(url, response)
    await once(response, 'chunk')
    const closed = once(response, 'close')
    response.emit('close')
    await closed
    await dispatched.completion
    routes.dispose()

    expect(response.body.length).toBeLessThan(size)
    expect(response.destroyed).toBe(true)
  })

  it('rolls back an earlier route when a later registration fails', () => {
    let registrations = 0
    let disposals = 0
    const ctx = {
      webServer: {
        register() {
          registrations += 1
          if (registrations === 2) throw new Error('duplicate route')
          return () => { disposals += 1 }
        },
      },
    } as unknown as Context
    const gate: WorkspaceGate = async () => ({ ok: true, canonical: root })

    expect(() => registerBrowserRoutes(ctx, gate, new OpenBroadcaster())).toThrow('duplicate route')
    expect(disposals).toBe(1)
  })
})
