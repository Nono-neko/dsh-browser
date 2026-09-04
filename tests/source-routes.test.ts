import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserEnvelope } from '../src/core/types.ts'
import type { SourceDocument } from '../src/core/editor.ts'
import type { WorkspaceGate } from '../src/host/gate.ts'
import { handleSourceRoute } from '../src/host/source-routes.ts'

class CapturedResponse extends Writable {
  status = 0
  readonly headers: Record<string, string | number> = {}
  private readonly chunks: Buffer[] = []

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.status = status
    for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value
    return this
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    callback()
  }
}

function request(
  method: string,
  url: string,
  body?: unknown,
  remoteAddress = '127.0.0.1',
  headers: Record<string, string> = {},
): IncomingMessage {
  const source = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(source) as Readable & {
    method: string
    url: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  req.method = method
  req.url = url
  req.headers = { host: 'localhost:3000', origin: 'http://localhost:3000', ...headers }
  req.socket = { remoteAddress }
  return req as unknown as IncomingMessage
}

async function dispatch(req: IncomingMessage, gate: WorkspaceGate): Promise<CapturedResponse> {
  const response = new CapturedResponse()
  await handleSourceRoute(req, response as unknown as ServerResponse, gate)
  if (!response.writableFinished && !response.destroyed) await once(response, 'finish')
  return response
}

describe('source editor route', () => {
  let base: string
  let root: string
  let gate: WorkspaceGate

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-browser-source-')))
    root = join(base, 'workspace')
    await mkdir(root)
    gate = async value => value === root
      ? { ok: true, canonical: root }
      : { ok: false, error: { code: 'workspace-unknown', message: 'unknown workspace' } }
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('reads a text file with a content hash', async () => {
    await writeFile(join(root, 'app.ts'), 'export const value = 1\n')
    const query = new URLSearchParams({ root, path: 'app.ts' })

    const response = await dispatch(request('GET', `/api/dsh-browser/source?${query}`), gate)
    const envelope = JSON.parse(response.body) as BrowserEnvelope<SourceDocument>

    expect(response.status).toBe(200)
    expect(envelope.ok && envelope.value.content).toContain('value = 1')
    expect(envelope.ok && envelope.value.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('atomically saves when the expected hash still matches', async () => {
    await writeFile(join(root, 'app.ts'), 'before\n')
    const query = new URLSearchParams({ root, path: 'app.ts' })
    const read = await dispatch(request('GET', `/api/dsh-browser/source?${query}`), gate)
    const first = JSON.parse(read.body) as BrowserEnvelope<SourceDocument>
    if (!first.ok) throw new Error('read failed')

    const response = await dispatch(request('PUT', '/api/dsh-browser/source', {
      workspaceRoot: root,
      path: 'app.ts',
      content: 'after\n',
      expectedHash: first.value.hash,
    }), gate)

    expect(response.status).toBe(200)
    expect(await readFile(join(root, 'app.ts'), 'utf8')).toBe('after\n')
    expect(JSON.parse(response.body).value.hash).not.toBe(first.value.hash)
  })

  it('refuses to overwrite a concurrently changed file', async () => {
    await writeFile(join(root, 'app.ts'), 'first\n')
    const query = new URLSearchParams({ root, path: 'app.ts' })
    const read = await dispatch(request('GET', `/api/dsh-browser/source?${query}`), gate)
    const first = JSON.parse(read.body) as BrowserEnvelope<SourceDocument>
    if (!first.ok) throw new Error('read failed')
    await writeFile(join(root, 'app.ts'), 'agent change\n')

    const response = await dispatch(request('PUT', '/api/dsh-browser/source', {
      workspaceRoot: root,
      path: 'app.ts',
      content: 'user change\n',
      expectedHash: first.value.hash,
    }), gate)

    expect(response.status).toBe(409)
    expect(await readFile(join(root, 'app.ts'), 'utf8')).toBe('agent change\n')
  })

  it('refuses a path that resolves outside the registered root', async () => {
    await writeFile(join(base, 'outside.txt'), 'secret')
    const query = new URLSearchParams({ root, path: '../outside.txt' })

    const response = await dispatch(request('GET', `/api/dsh-browser/source?${query}`), gate)

    expect(response.status).toBe(403)
    expect(response.body).toContain('path-outside-root')
  })

  it('rejects non-UTF-8 files instead of silently corrupting them', async () => {
    await writeFile(join(root, 'legacy.txt'), Buffer.from([0xc3, 0x28]))
    const query = new URLSearchParams({ root, path: 'legacy.txt' })

    const response = await dispatch(request('GET', `/api/dsh-browser/source?${query}`), gate)

    expect(response.status).toBe(400)
    expect(response.body).toContain('valid UTF-8')
  })

  it('rejects non-loopback clients before reading a workspace', async () => {
    const query = new URLSearchParams({ root, path: 'app.ts' })
    const response = await dispatch(request('GET', `/api/dsh-browser/source?${query}`, undefined, '192.168.1.20'), gate)
    expect(response.status).toBe(403)
  })

  it('rejects source writes from an opaque preview script', async () => {
    const response = await dispatch(request(
      'PUT',
      '/api/dsh-browser/source',
      { workspaceRoot: root, path: 'app.ts', content: 'changed', expectedHash: 'x' },
      '127.0.0.1',
      { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty' },
    ), gate)
    expect(response.status).toBe(403)
  })
})
