/** Loopback and workspace-gated HTTP surface for browser review comments. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ReviewCommentCreate, ReviewContext, ReviewSourceLocation, ReviewTarget } from '../core/review.ts'
import type { BrowserError } from '../core/types.ts'
import { forbidden, isLoopbackRequest, json, readJsonBody } from './http.ts'
import { ReviewStore, ReviewStoreError } from './review-store.ts'
import type { WorkspaceGate } from './gate.ts'

const COMMENTS_ROUTE = '/api/dsh-browser/comments'
const RESOLVE_ROUTE = '/api/dsh-browser/comments/resolve'
const BATCHES_ROUTE = '/api/dsh-browser/review-batches'
const REOPEN_BATCH_ROUTE = '/api/dsh-browser/review-batches/reopen'

const OK = <T>(value: T) => ({ ok: true as const, value })
const FAIL = (error: BrowserError) => ({ ok: false as const, error })

/** Handle one review-family request. Caller invokes only for known paths. */
export async function handleReviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  gate: WorkspaceGate,
  store: ReviewStore,
): Promise<void> {
  if (!isLoopbackRequest(req)) {
    forbidden(res)
    return
  }
  const url = new URL(req.url ?? '/', 'http://x')
  try {
    if (url.pathname === COMMENTS_ROUTE && req.method === 'GET') {
      const root = url.searchParams.get('root') ?? ''
      const canonical = await requireWorkspace(root, gate)
      json(res, OK(store.list(canonical)))
      return
    }
    if (url.pathname === COMMENTS_ROUTE && req.method === 'DELETE') {
      const root = url.searchParams.get('root') ?? ''
      const canonical = await requireWorkspace(root, gate)
      const commentId = stringValue(url.searchParams.get('id'), 256)
      json(res, OK(store.deleteDraft(canonical, commentId)))
      return
    }
    if (url.pathname === COMMENTS_ROUTE && req.method === 'POST') {
      const body = await requireJson(req)
      const root = stringField(body, 'workspaceRoot', 16_384)
      const canonical = await requireWorkspace(root, gate)
      const input = parseCreate(body, canonical)
      json(res, OK(store.create(input)), 201)
      return
    }
    if (url.pathname === BATCHES_ROUTE && req.method === 'POST') {
      const body = await requireJson(req)
      const root = stringField(body, 'workspaceRoot', 16_384)
      const canonical = await requireWorkspace(root, gate)
      const commentIds = stringArrayField(body, 'commentIds', 500)
      json(res, OK(store.createBatch(canonical, commentIds)), 201)
      return
    }
    if (url.pathname === REOPEN_BATCH_ROUTE && req.method === 'POST') {
      const body = await requireJson(req)
      const root = stringField(body, 'workspaceRoot', 16_384)
      const canonical = await requireWorkspace(root, gate)
      const batchId = stringField(body, 'batchId', 256)
      json(res, OK(store.reopenBatch(canonical, batchId)))
      return
    }
    if (url.pathname === RESOLVE_ROUTE && req.method === 'POST') {
      const body = await requireJson(req)
      const root = stringField(body, 'workspaceRoot', 16_384)
      const canonical = await requireWorkspace(root, gate)
      const commentIds = stringArrayField(body, 'commentIds', 500)
      json(res, OK(store.resolve(commentIds, canonical)))
      return
    }
    res.writeHead(req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE' ? 404 : 405, {
      'content-type': 'application/json; charset=utf-8',
      allow: 'GET, POST, DELETE',
    })
    res.end(JSON.stringify({ error: 'review route not found' }))
  } catch (error) {
    if (error instanceof RouteError) {
      json(res, FAIL(error.error), error.status)
      return
    }
    if (error instanceof ReviewStoreError) {
      const status = error.code === 'not-found' ? 404 : error.code === 'conflict' ? 409 : 400
      const code: BrowserError['code'] = error.code === 'not-found' ? 'not-found' : error.code === 'conflict' ? 'conflict' : 'bad-request'
      json(res, FAIL({ code, message: error.message }), status)
      return
    }
    throw error
  }
}

class RouteError extends Error {
  constructor(readonly status: number, readonly error: BrowserError) {
    super(error.message)
  }
}

async function requireWorkspace(root: string, gate: WorkspaceGate): Promise<string> {
  if (root === '') throw new RouteError(400, { code: 'bad-request', message: 'workspace root is required' })
  const result = await gate(root)
  if (!result.ok) throw new RouteError(400, result.error)
  return result.canonical
}

async function requireJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const result = await readJsonBody(req)
  if (!result.ok) throw new RouteError(result.status, result.error)
  return record(result.value, 'request body')
}

function parseCreate(body: Record<string, unknown>, workspaceRoot: string): ReviewCommentCreate {
  return {
    workspaceRoot,
    url: stringField(body, 'url', 8_192),
    tabId: stringField(body, 'tabId', 256),
    text: stringField(body, 'text', 8_000),
    target: parseTarget(record(body.target, 'target')),
    context: parseContext(record(body.context, 'context')),
  }
}

function parseTarget(value: Record<string, unknown>): ReviewTarget {
  const kind = value.kind
  if (kind !== 'element' && kind !== 'region') {
    throw new ReviewStoreError('invalid', 'target kind is invalid')
  }
  const attributesValue = record(value.attributes, 'target.attributes')
  const attributes: Record<string, string> = {}
  if (Object.keys(attributesValue).length > 64) throw new ReviewStoreError('invalid', 'too many target attributes')
  for (const [key, raw] of Object.entries(attributesValue)) {
    if (typeof raw !== 'string' || key.length > 256 || raw.length > 1_000) {
      throw new ReviewStoreError('invalid', 'target attribute is invalid')
    }
    attributes[key] = raw
  }
  const sourceValue = value.source
  let source: ReviewSourceLocation | undefined
  if (sourceValue !== undefined && sourceValue !== null) {
    const row = record(sourceValue, 'target.source')
    source = {
      file: stringField(row, 'file', 4_096),
      line: optionalInteger(row.line),
      column: optionalInteger(row.column),
    }
  }
  const rect = record(value.rect, 'target.rect')
  return {
    kind,
    source,
    selector: stringField(value, 'selector', 4_096, true),
    textQuote: stringField(value, 'textQuote', 2_000, true),
    tagName: stringField(value, 'tagName', 128),
    attributes,
    outerHTML: stringField(value, 'outerHTML', 16_000, true),
    rect: {
      x: finiteNumber(rect.x),
      y: finiteNumber(rect.y),
      width: finiteNumber(rect.width),
      height: finiteNumber(rect.height),
    },
  }
}

function parseContext(value: Record<string, unknown>): ReviewContext {
  return {
    viewportWidth: finiteNumber(value.viewportWidth),
    viewportHeight: finiteNumber(value.viewportHeight),
    devicePixelRatio: finiteNumber(value.devicePixelRatio),
    scrollX: optionalFiniteNumber(value.scrollX),
    scrollY: optionalFiniteNumber(value.scrollY),
    documentWidth: optionalFiniteNumber(value.documentWidth),
    documentHeight: optionalFiniteNumber(value.documentHeight),
    pageRevision: value.pageRevision === undefined || value.pageRevision === null
      ? undefined
      : stringValue(value.pageRevision, 512, true),
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewStoreError('invalid', `${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, field: string, max: number, empty = false): string {
  return stringValue(value[field], max, empty)
}

function stringValue(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && value.trim() === '')) {
    throw new ReviewStoreError('invalid', 'string field is invalid')
  }
  return value
}

function stringArrayField(value: Record<string, unknown>, field: string, max: number): string[] {
  const array = value[field]
  if (!Array.isArray(array) || array.length === 0 || array.length > max) {
    throw new ReviewStoreError('invalid', `${field} is invalid`)
  }
  return array.map(entry => stringValue(entry, 256))
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ReviewStoreError('invalid', 'number field is invalid')
  return value
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  return finiteNumber(value)
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ReviewStoreError('invalid', 'source location is invalid')
  }
  return value
}
