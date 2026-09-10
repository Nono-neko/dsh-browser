import { describe, expect, it, vi } from 'vitest'
import { captureReviewScreenshot, deleteReviewComment, fetchPreviewSession } from '../src/client/api.ts'

describe('captureReviewScreenshot', () => {
  it('requests a bounded viewport and returns prompt-ready PNG base64', async () => {
    const fetchImpl = vi.fn(async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })) as unknown as typeof fetch

    const result = await captureReviewScreenshot(
      'C:/work/project',
      '/api/dsh-browser/file?root=C%3A%2Fwork%2Fproject&path=index.html',
      800.4,
      599.6,
      fetchImpl,
    )

    const requestUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]), 'http://localhost')
    expect(requestUrl.pathname).toBe('/api/dsh-browser/screenshot')
    expect(requestUrl.searchParams.get('width')).toBe('800')
    expect(requestUrl.searchParams.get('height')).toBe('600')
    expect(result).toMatchObject({
      mediaType: 'image/png',
      data: 'AQID',
      viewportWidth: 800,
      viewportHeight: 600,
    })
  })

  it('rejects non-PNG capture responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as unknown as typeof fetch

    await expect(captureReviewScreenshot('C:/work/project', 'https://example.com/', 800, 600, fetchImpl))
      .rejects.toThrow('not PNG')
  })
})

describe('deleteReviewComment', () => {
  it('deletes one draft through the workspace-gated comments route', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      value: { id: 'comment-1', status: 'draft' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    await deleteReviewComment('C:/work/project', 'comment-1', fetchImpl)

    const [input, init] = vi.mocked(fetchImpl).mock.calls[0]
    const requestUrl = new URL(String(input), 'http://localhost')
    expect(requestUrl.pathname).toBe('/api/dsh-browser/comments')
    expect(requestUrl.searchParams.get('root')).toBe('C:/work/project')
    expect(requestUrl.searchParams.get('id')).toBe('comment-1')
    expect(init?.method).toBe('DELETE')
  })
})

describe('fetchPreviewSession', () => {
  it('accepts a capability-scoped loopback preview carrier', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      value: { baseUrl: 'http://127.0.0.1:49231/_dsh-browser-preview/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    await expect(fetchPreviewSession(fetchImpl)).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:49231/_dsh-browser-preview/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    })
    expect(fetchImpl).toHaveBeenCalledWith('/api/dsh-browser/preview-session', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
  })

  it('rejects a non-loopback carrier returned by the host', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      value: { baseUrl: 'https://example.com/preview' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    await expect(fetchPreviewSession(fetchImpl)).rejects.toThrow('invalid preview carrier')
  })
})
