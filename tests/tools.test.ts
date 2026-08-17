import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The SSRF guard resolves hostnames through node:dns; stub the module so the
// tests never touch the network or a real resolver. The ESM namespace mock
// needs both the named export and a default export.
vi.mock('node:dns/promises', () => {
  const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
  return { default: { lookup }, lookup }
})

import { browserOpenTool, fetchGuarded, readPage } from '../src/host/tools.ts'

describe('fetchGuarded', () => {
  it('refuses literal private addresses before any fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const outcome = await fetchGuarded('http://192.168.0.1/', false, { fetch: fetchMock })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('private-address guard')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('follows redirects hop by hop and re-checks each one', async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: 'http://192.168.0.1/secret' } }),
    ]
    const fetchMock = vi.fn(async () => responses.shift() as Response)
    const outcome = await fetchGuarded('https://public.example/start', false, { fetch: fetchMock })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('private-address guard')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns the final response after public redirects', async () => {
    const responses = [
      new Response(null, { status: 301, headers: { location: '/final' } }),
      new Response('<html><title>T</title><p>body</p></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]
    const fetchMock = vi.fn(async () => responses.shift() as Response)
    const outcome = await fetchGuarded('https://public.example/start', false, { fetch: fetchMock })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.finalUrl).toBe('https://public.example/final')
      expect(outcome.res.status).toBe(200)
    }
  })

  it('allows private targets when the override is on', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }))
    const outcome = await fetchGuarded('http://192.168.0.1/', true, { fetch: fetchMock })
    expect(outcome.ok).toBe(true)
  })

  it('rejects non-http schemes', async () => {
    const outcome = await fetchGuarded('ftp://example.com/x', true, { fetch: vi.fn<typeof fetch>() })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('only http(s)')
  })
})

describe('readPage', () => {
  it('extracts title and text from HTML', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '<html><head><title>Page Title</title></head><body><script>var x=1;</script><p>Hello body</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ))
    const result = await readPage('https://public.example/page', false, 10000, { fetch: fetchMock })
    expect(result.ok).toBe(true)
    expect(result.title).toBe('Page Title')
    expect(result.text).toContain('Hello body')
    expect(result.text).not.toContain('var x')
  })

  it('reports unsupported content types', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }))
    const result = await readPage('https://public.example/bin', false, 1000, { fetch: fetchMock })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unsupported content type')
  })

  it('respects the content-length cap', async () => {
    const fetchMock = vi.fn(async () => new Response('x', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': String(3 * 1024 * 1024) },
    }))
    const result = await readPage('https://public.example/big', false, 1000, { fetch: fetchMock })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('byte cap')
  })
})

describe('browserOpenTool', () => {
  it('broadcasts http(s) URLs and reports delivery', async () => {
    const pushed: string[] = []
    const tool = browserOpenTool((url) => { pushed.push(url); return 1 })
    const run = tool.execute as (args: { url: string }) => Promise<{ opened: boolean; url: string; message: string }>
    const result = await run({ url: 'https://example.com/' })
    expect(result.opened).toBe(true)
    expect(result.url).toBe('https://example.com/')
    expect(pushed).toEqual(['https://example.com/'])
  })

  it('refuses non-http URLs without broadcasting', async () => {
    const pushed: string[] = []
    const tool = browserOpenTool((url) => { pushed.push(url); return 1 })
    const run = tool.execute as (args: { url: string }) => Promise<{ opened: boolean }>
    const result = await run({ url: 'file:///etc/passwd' })
    expect(result.opened).toBe(false)
    expect(pushed).toEqual([])
  })

  it('reports when no panel is connected', async () => {
    const tool = browserOpenTool(() => 0)
    const run = tool.execute as (args: { url: string }) => Promise<{ opened: boolean; message: string }>
    const result = await run({ url: 'https://example.com/' })
    expect(result.opened).toBe(false)
    expect(result.message).toContain('no GUI panel')
  })
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})
