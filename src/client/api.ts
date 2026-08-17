/**
 * Wire layer for the browser half: the SSE open-event subscription and the
 * workspace listing fetch. All calls are loopback JSON/SSE against the host
 * half's /api/dsh-browser routes.
 * @module dsh-browser/client/api
 */

import type { BrowserEnvelope, WorkspaceListing } from '../core/types.ts'

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
