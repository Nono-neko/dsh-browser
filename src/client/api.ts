/**
 * Wire layer for the browser half: the SSE open-event subscription and the
 * workspace listing fetch. All calls are loopback JSON/SSE against the host
 * half's /api/dsh-browser routes.
 * @module dsh-browser/client/api
 */

import type { BrowserEnvelope, WorkspaceListing } from '../core/types.ts'
import type { ReviewBatchView, ReviewComment, ReviewCommentCreate, ReviewScreenshot } from '../core/review.ts'
import type { SourceDocument, SourceWrite } from '../core/editor.ts'

/** Subscribe to host open events (agent browser_open pushes). */
export function subscribeOpenEvents(onOpen: (url: string) => void): () => void {
  const source = new EventSource('/api/dsh-browser/events')
  source.addEventListener('open', (event) => {
    const data = event as MessageEvent<string>
    try {
      const parsed = JSON.parse(data.data) as { kind?: string; url?: string }
      if (parsed.kind === 'open' && typeof parsed.url === 'string' && parsed.url !== '') {
        onOpen(parsed.url)
      }
    } catch {
      // Ignore malformed frames.
    }
  })
  return () => { source.close() }
}

/** List one workspace directory through the host route. */
export async function listWorkspace(
  root: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkspaceListing> {
  const query = new URLSearchParams({ root })
  if (path !== '') query.set('path', path)
  const res = await fetchImpl(`/api/dsh-browser/list?${query.toString()}`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`)
  const envelope = await res.json() as BrowserEnvelope<WorkspaceListing>
  if (!envelope.ok) throw new Error(envelope.error.message)
  return envelope.value
}

/** Build the file-serving URL for one workspace file. */
export function fileUrl(root: string, path: string): string {
  const query = new URLSearchParams({ root, path })
  return `/api/dsh-browser/file?${query.toString()}`
}

/** Capture one rendered review viewport and return a prompt-ready PNG. */
export async function captureReviewScreenshot(
  workspaceRoot: string,
  url: string,
  viewportWidth: number,
  viewportHeight: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ReviewScreenshot> {
  const width = Math.round(viewportWidth)
  const height = Math.round(viewportHeight)
  const query = new URLSearchParams({
    root: workspaceRoot,
    url,
    width: String(width),
    height: String(height),
  })
  const response = await fetchImpl(`/api/dsh-browser/screenshot?${query.toString()}`, {
    headers: { accept: 'image/png' },
  })
  if (!response.ok) throw new Error(`screenshot failed: HTTP ${response.status}`)
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]
  if (mediaType !== 'image/png') throw new Error('screenshot response is not PNG')
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return {
    url,
    viewportWidth: width,
    viewportHeight: height,
    mediaType: 'image/png',
    data: btoa(binary),
    name: 'dsh-browser-review.png',
  }
}

/** List every review comment retained for one registered workspace. */
export async function listReviewComments(root: string, fetchImpl: typeof fetch = fetch): Promise<ReviewComment[]> {
  const query = new URLSearchParams({ root })
  return requestEnvelope<ReviewComment[]>(`/api/dsh-browser/comments?${query.toString()}`, undefined, fetchImpl)
}

/** Save one draft review comment where Agent tools can read it. */
export async function createReviewComment(
  input: ReviewCommentCreate,
  fetchImpl: typeof fetch = fetch,
): Promise<ReviewComment> {
  return requestEnvelope<ReviewComment>('/api/dsh-browser/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input),
  }, fetchImpl)
}

/** Delete one unsubmitted review draft. */
export async function deleteReviewComment(
  workspaceRoot: string,
  commentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReviewComment> {
  const query = new URLSearchParams({ root: workspaceRoot, id: commentId })
  return requestEnvelope<ReviewComment>(`/api/dsh-browser/comments?${query.toString()}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  }, fetchImpl)
}

/** Confirm a draft group and mint the batch id sent to the current Agent. */
export async function createReviewBatch(
  workspaceRoot: string,
  commentIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<ReviewBatchView> {
  return requestEnvelope<ReviewBatchView>('/api/dsh-browser/review-batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ workspaceRoot, commentIds }),
  }, fetchImpl)
}

/** Return a batch to draft state when its Agent message was not enqueued. */
export async function reopenReviewBatch(
  workspaceRoot: string,
  batchId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReviewComment[]> {
  return requestEnvelope<ReviewComment[]>('/api/dsh-browser/review-batches/reopen', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ workspaceRoot, batchId }),
  }, fetchImpl)
}

async function requestEnvelope<T>(url: string, init: RequestInit | undefined, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, init)
  let envelope: BrowserEnvelope<T>
  try {
    envelope = await res.json() as BrowserEnvelope<T>
  } catch {
    throw new Error(`browser API failed: HTTP ${res.status}`)
  }
  if (!res.ok || !envelope.ok) {
    const message = envelope.ok ? `HTTP ${res.status}` : envelope.error.message
    throw new Error(message)
  }
  return envelope.value
}

/** Read one bounded text file for the lightweight editor. */
export async function readSourceDocument(
  workspaceRoot: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceDocument> {
  const query = new URLSearchParams({ root: workspaceRoot, path })
  return requestEnvelope<SourceDocument>(`/api/dsh-browser/source?${query.toString()}`, undefined, fetchImpl)
}

/** Save one source document with optimistic hash conflict detection. */
export async function writeSourceDocument(
  input: SourceWrite,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceDocument> {
  return requestEnvelope<SourceDocument>('/api/dsh-browser/source', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input),
  }, fetchImpl)
}
