/** Workspace-gated read/write API for the lightweight source editor. */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { SourceDocument } from '../core/editor.ts'
import type { BrowserError } from '../core/types.ts'
import type { WorkspaceGate } from './gate.ts'
import { forbidden, isLoopbackRequest, json, readJsonBody } from './http.ts'
import { resolveInside } from './workspace-path.ts'

const SOURCE_ROUTE = '/api/dsh-browser/source'
const MAX_SOURCE_BYTES = 4 * 1024 * 1024
// JSON escaping can expand control-heavy text up to six bytes per source byte.
const MAX_SOURCE_REQUEST_BYTES = MAX_SOURCE_BYTES * 6 + 256 * 1024

const OK = <T>(value: T) => ({ ok: true as const, value })
const FAIL = (error: BrowserError) => ({ ok: false as const, error })

export async function handleSourceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  gate: WorkspaceGate,
): Promise<void> {
  if (!isLoopbackRequest(req)) {
    forbidden(res)
    return
  }
  const url = new URL(req.url ?? '/', 'http://x')
  try {
    if (url.pathname !== SOURCE_ROUTE) {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method === 'GET') {
      const root = url.searchParams.get('root') ?? ''
      const path = url.searchParams.get('path') ?? ''
      const target = await sourceTarget(root, path, gate)
      json(res, OK(await readSource(target.root, target.path, target.canonical)))
      return
    }
    if (req.method === 'PUT') {
      const bodyResult = await readJsonBody(req, MAX_SOURCE_REQUEST_BYTES)
      if (!bodyResult.ok) {
        json(res, FAIL(bodyResult.error), bodyResult.status)
        return
      }
      const body = record(bodyResult.value)
      const root = requiredString(body.workspaceRoot, 16_384)
      const path = requiredString(body.path, 16_384)
      const content = stringValue(body.content, MAX_SOURCE_BYTES, true)
      const expectedHash = requiredString(body.expectedHash, 256)
      if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) {
        throw new SourceRouteError(413, { code: 'too-large', message: 'source file exceeds the editor size limit' })
      }
      const target = await sourceTarget(root, path, gate)
      const current = await readSource(target.root, target.path, target.canonical)
      if (current.hash !== expectedHash) {
        throw new SourceRouteError(409, { code: 'conflict', message: 'source file changed since it was opened' })
      }
      await atomicWrite(target.canonical, content)
      json(res, OK(await readSource(target.root, target.path, target.canonical)))
      return
    }
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, PUT' })
    res.end(JSON.stringify({ error: 'source route supports GET and PUT only' }))
  } catch (error) {
    if (error instanceof SourceRouteError) {
      json(res, FAIL(error.error), error.status)
      return
    }
    throw error
  }
}

class SourceRouteError extends Error {
  constructor(readonly status: number, readonly error: BrowserError) {
    super(error.message)
  }
}

async function sourceTarget(root: string, path: string, gate: WorkspaceGate): Promise<{ root: string; path: string; canonical: string }> {
  if (root === '' || path === '') throw new SourceRouteError(400, { code: 'bad-request', message: 'workspace root and file path are required' })
  const gated = await gate(root)
  if (!gated.ok) throw new SourceRouteError(400, gated.error)
  const resolved = await resolveInside(gated.canonical, root, path)
  if (!resolved.ok) {
    throw new SourceRouteError(resolved.error.code === 'not-found' ? 404 : 403, resolved.error)
  }
  return { root: gated.canonical, path, canonical: resolved.canonical }
}

async function readSource(root: string, path: string, canonical: string): Promise<SourceDocument> {
  let info
  try {
    info = await stat(canonical)
  } catch {
    throw new SourceRouteError(404, { code: 'not-found', message: 'source file does not exist' })
  }
  if (!info.isFile()) throw new SourceRouteError(400, { code: 'is-directory', message: 'source path is a directory' })
  if (info.size > MAX_SOURCE_BYTES) throw new SourceRouteError(413, { code: 'too-large', message: 'source file exceeds the editor size limit' })
  const buffer = await readFile(canonical)
  if (buffer.includes(0)) throw new SourceRouteError(400, { code: 'bad-request', message: 'binary files cannot be edited' })
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new SourceRouteError(400, { code: 'bad-request', message: 'editor source files must be valid UTF-8 text' })
  }
  return {
    root,
    path,
    content,
    hash: hash(buffer),
    size: buffer.byteLength,
    mtimeMs: info.mtimeMs,
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const info = await stat(target)
  const temporary = join(dirname(target), `.dsh-browser-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: info.mode })
    await chmod(temporary, info.mode)
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SourceRouteError(400, { code: 'bad-request', message: 'request body must be an object' })
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, max: number): string {
  return stringValue(value, max, false)
}

function stringValue(value: unknown, max: number, empty: boolean): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max || (!empty && value.trim() === '')) {
    throw new SourceRouteError(400, { code: 'bad-request', message: 'string field is invalid' })
  }
  return value
}
