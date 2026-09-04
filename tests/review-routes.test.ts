import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { ReviewComment } from '../src/core/review.ts'
import type { BrowserEnvelope } from '../src/core/types.ts'
import type { WorkspaceGate } from '../src/host/gate.ts'
import { handleReviewRoute } from '../src/host/review-routes.ts'
import { ReviewStore } from '../src/host/review-store.ts'

class CapturedResponse extends Writable {
  status = 0
  private readonly chunks: Buffer[] = []

  writeHead(status: number): this {
    this.status = status
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

function request(method: string, url: string, body?: unknown, remoteAddress = '127.0.0.1'): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as Readable & {
    method: string
    url: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  req.method = method
  req.url = url
  req.headers = { host: 'localhost:3000', origin: 'http://localhost:3000' }
  req.socket = { remoteAddress }
  return req as unknown as IncomingMessage
}

async function dispatch(req: IncomingMessage, gate: WorkspaceGate, store: ReviewStore): Promise<CapturedResponse> {
  const response = new CapturedResponse()
  await handleReviewRoute(req, response as unknown as ServerResponse, gate, store)
  if (!response.writableFinished && !response.destroyed) await once(response, 'finish')
  return response
}

function createBody(root: string) {
  return {
    workspaceRoot: root,
    url: 'http://localhost:5173/',
    tabId: 'tab-1',
    text: 'Make this heading smaller.',
    target: {
      kind: 'element',
      source: { file: 'src/App.tsx', line: 8, column: 3 },
      selector: '#app > h1',
      textQuote: 'Hello',
      tagName: 'h1',
      attributes: { class: 'title' },
      outerHTML: '<h1 class="title">Hello</h1>',
      rect: { x: 10, y: 20, width: 120, height: 40 },
    },
    context: { viewportWidth: 1280, viewportHeight: 800, devicePixelRatio: 1 },
  }
}

describe('review routes', () => {
  const root = 'C:/canonical/workspace'
  const gate: WorkspaceGate = async value => value === 'C:/requested/workspace'
    ? { ok: true, canonical: root }
    : { ok: false, error: { code: 'workspace-unknown', message: 'unknown workspace' } }

  it('creates, lists, and confirms one workspace review batch', async () => {
    const store = new ReviewStore()
    const createdResponse = await dispatch(request('POST', '/api/dsh-browser/comments', createBody('C:/requested/workspace')), gate, store)
    const created = JSON.parse(createdResponse.body) as BrowserEnvelope<ReviewComment>
    expect(createdResponse.status).toBe(201)
    if (!created.ok) throw new Error('create failed')
    expect(created.value.workspaceRoot).toBe(root)
    expect(created.value.target.kind).toBe('element')

    const listedResponse = await dispatch(request('GET', `/api/dsh-browser/comments?root=${encodeURIComponent('C:/requested/workspace')}`), gate, store)
    const listed = JSON.parse(listedResponse.body) as BrowserEnvelope<ReviewComment[]>
    expect(listed.ok && listed.value).toHaveLength(1)

    const batchResponse = await dispatch(request('POST', '/api/dsh-browser/review-batches', {
      workspaceRoot: 'C:/requested/workspace',
      commentIds: [created.value.id],
    }), gate, store)
    expect(batchResponse.status).toBe(201)
    expect(batchResponse.body).toContain('submitted')
    const batchEnvelope = JSON.parse(batchResponse.body) as BrowserEnvelope<{ batch: { id: string } }>
    if (!batchEnvelope.ok) throw new Error('batch failed')

    const reopenResponse = await dispatch(request('POST', '/api/dsh-browser/review-batches/reopen', {
      workspaceRoot: 'C:/requested/workspace',
      batchId: batchEnvelope.value.batch.id,
    }), gate, store)
    expect(reopenResponse.status).toBe(200)
    expect(reopenResponse.body).toContain('draft')
  })

  it('rejects comments for an unregistered workspace', async () => {
    const response = await dispatch(request('POST', '/api/dsh-browser/comments', createBody('C:/unknown')), gate, new ReviewStore())
    expect(response.status).toBe(400)
    expect(response.body).toContain('workspace-unknown')
  })

  it('deletes a draft comment from its workspace', async () => {
    const store = new ReviewStore()
    const createdResponse = await dispatch(request('POST', '/api/dsh-browser/comments', createBody('C:/requested/workspace')), gate, store)
    const created = JSON.parse(createdResponse.body) as BrowserEnvelope<ReviewComment>
    if (!created.ok) throw new Error('create failed')

    const query = new URLSearchParams({ root: 'C:/requested/workspace', id: created.value.id })
    const deleted = await dispatch(request('DELETE', `/api/dsh-browser/comments?${query.toString()}`), gate, store)

    expect(deleted.status).toBe(200)
    expect(deleted.body).toContain(created.value.id)
    expect(store.list(root)).toEqual([])
  })

  it('refuses to delete a comment after it was submitted to the Agent', async () => {
    const store = new ReviewStore()
    const createdResponse = await dispatch(request('POST', '/api/dsh-browser/comments', createBody('C:/requested/workspace')), gate, store)
    const created = JSON.parse(createdResponse.body) as BrowserEnvelope<ReviewComment>
    if (!created.ok) throw new Error('create failed')
    store.createBatch(root, [created.value.id])

    const query = new URLSearchParams({ root: 'C:/requested/workspace', id: created.value.id })
    const response = await dispatch(request('DELETE', `/api/dsh-browser/comments?${query.toString()}`), gate, store)

    expect(response.status).toBe(409)
    expect(response.body).toContain('not a draft')
    expect(store.list(root)).toHaveLength(1)
  })

  it('accepts parent-layer region comments and rejects unknown target kinds', async () => {
    const body = createBody('C:/requested/workspace')
    const regionTarget = body.target as unknown as Record<string, unknown>
    Object.assign(regionTarget, {
      kind: 'region',
      selector: '',
      textQuote: '',
      tagName: 'region',
      attributes: {},
      outerHTML: '',
    })
    delete regionTarget.source
    const accepted = await dispatch(request('POST', '/api/dsh-browser/comments', body), gate, new ReviewStore())
    expect(accepted.status).toBe(201)
    expect(accepted.body).toContain('"kind":"region"')

    const invalid = createBody('C:/requested/workspace')
    const invalidTarget = invalid.target as unknown as Record<string, unknown>
    invalidTarget.kind = 'unknown'
    const rejected = await dispatch(request('POST', '/api/dsh-browser/comments', invalid), gate, new ReviewStore())
    expect(rejected.status).toBe(400)
    expect(rejected.body).toContain('target kind is invalid')
  })

  it('preserves live-page scroll context and rejects malformed values', async () => {
    const body = createBody('C:/requested/workspace')
    Object.assign(body.context, {
      scrollX: 12,
      scrollY: 840,
      documentWidth: 1280,
      documentHeight: 3200,
    })
    const accepted = await dispatch(request('POST', '/api/dsh-browser/comments', body), gate, new ReviewStore())
    const envelope = JSON.parse(accepted.body) as BrowserEnvelope<ReviewComment>

    expect(accepted.status).toBe(201)
    expect(envelope.ok && envelope.value.context).toMatchObject({
      scrollX: 12,
      scrollY: 840,
      documentWidth: 1280,
      documentHeight: 3200,
    })

    const malformed = createBody('C:/requested/workspace')
    Object.assign(malformed.context, { scrollY: 'not-a-number' })
    const rejected = await dispatch(request('POST', '/api/dsh-browser/comments', malformed), gate, new ReviewStore())

    expect(rejected.status).toBe(400)
    expect(rejected.body).toContain('number field is invalid')
  })

  it('rejects cross-site and non-loopback mutation requests', async () => {
    const response = await dispatch(
      request('POST', '/api/dsh-browser/comments', createBody('C:/requested/workspace'), '10.0.0.5'),
      gate,
      new ReviewStore(),
    )
    expect(response.status).toBe(403)
  })

  it('rejects draft deletion from a non-loopback client', async () => {
    const store = new ReviewStore()
    const createdResponse = await dispatch(request('POST', '/api/dsh-browser/comments', createBody('C:/requested/workspace')), gate, store)
    const created = JSON.parse(createdResponse.body) as BrowserEnvelope<ReviewComment>
    if (!created.ok) throw new Error('create failed')
    const query = new URLSearchParams({ root: 'C:/requested/workspace', id: created.value.id })

    const response = await dispatch(
      request('DELETE', `/api/dsh-browser/comments?${query.toString()}`, undefined, '10.0.0.5'),
      gate,
      store,
    )

    expect(response.status).toBe(403)
    expect(store.list(root)).toHaveLength(1)
  })
})
