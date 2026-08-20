import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

function request(url: string): IncomingMessage {
  const req = new EventEmitter() as EventEmitter & {
    url: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  req.url = url
  req.headers = { host: 'localhost:3000', origin: 'http://localhost:3000' }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req as unknown as IncomingMessage
}

function routeHarness(gate: WorkspaceGate): {
  file: (url: string) => Promise<CapturedResponse>
  dispatch: (url: string, response: CapturedResponse) => {
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
  const dispatch = (url: string, response: CapturedResponse) => {
    const req = request(url)
    const completion = Promise.resolve(prefix.handler(req, response as unknown as ServerResponse))
    return { request: req, completion }
  }
  return {
    async file(url) {
      const res = new CapturedResponse()
      await dispatch(url, res).completion
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
