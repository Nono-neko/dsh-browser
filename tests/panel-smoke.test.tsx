import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserPanel } from '../src/client/panel/BrowserPanel.tsx'
import { fileUrl } from '../src/client/api.ts'
import { initialState, TabsStore } from '../src/client/store.ts'

// React 18's concurrent root batches the initial render; act flushes it so
// the jsdom queries below see the committed tree.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

describe('BrowserPanel smoke mount', () => {
  it('renders the tab strip, toolbar and a start tab', () => {
    const store = new TabsStore(() => 10)
    store.set(initialState('C:/work/proj'))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(BrowserPanel, {
        store,
        deps: {
          defaultHome: () => 'https://www.bing.com',
          maxTabs: () => 10,
          t: (key: string) => key,
          requestAgentReview: async () => 'batch-test',
        },
      }))
    })
    expect(host.querySelector('[data-active="true"]')).not.toBeNull()
    expect(host.textContent).toContain('start.title')
    act(() => { root.unmount() })
    host.remove()
  })

  it('mounts an iframe for a navigated tab', () => {
    const store = new TabsStore(() => 10)
    store.set(initialState('C:/work/proj'))
    const url = 'https://example.com/api/dsh-browser/file?root=x&path=y'
    store.openTab(url)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(BrowserPanel, {
        store,
        deps: {
          defaultHome: () => 'https://www.bing.com',
          maxTabs: () => 10,
          t: (key: string) => key,
          requestAgentReview: async () => 'batch-test',
        },
      }))
    })
    const frame = host.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame).not.toBeNull()
    const frameUrl = new URL(frame?.getAttribute('src') ?? '')
    expect(`${frameUrl.origin}${frameUrl.pathname}`).toBe('https://example.com/api/dsh-browser/file')
    expect(frameUrl.searchParams.get('root')).toBe('x')
    expect(frameUrl.searchParams.get('path')).toBe('y')
    expect(frameUrl.searchParams.get('reviewToken')).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-forms')
    act(() => { root.unmount() })
    host.remove()
  })

  it('uses the isolated preview carrier for Desktop iframe navigation', async () => {
    const originalUrl = window.location.href
    window.history.pushState({}, '', '/?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32&dsh-desktop-version=2.0.6')
    const baseUrl = 'http://127.0.0.1:49231/_dsh-browser-preview/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      value: { baseUrl },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const store = new TabsStore(() => 10)
    store.set(initialState('C:/work/proj'))
    store.navigate(store.getSnapshot().activeId as string, fileUrl('C:/work/proj', 'preview.html'))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(createElement(BrowserPanel, {
        store,
        deps: {
          defaultHome: () => 'https://www.bing.com',
          maxTabs: () => 10,
          t: (key: string) => key,
          requestAgentReview: async () => 'batch-test',
        },
      }))
    })

    const frame = host.querySelector('iframe') as HTMLIFrameElement | null
    expect(fetchMock).toHaveBeenCalledWith('/api/dsh-browser/preview-session', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    expect(frame?.src.startsWith(`${baseUrl}/api/dsh-browser/file?`)).toBe(true)
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')

    act(() => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
    window.history.replaceState({}, '', originalUrl)
  })

  it('strictly sandboxes a workspace file iframe', () => {
    const store = new TabsStore(() => 10)
    store.set(initialState('C:/work/proj'))
    store.navigate(store.getSnapshot().activeId as string, fileUrl('C:/work/proj', 'unsafe.svg'))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(BrowserPanel, {
        store,
        deps: {
          defaultHome: () => 'https://www.bing.com',
          maxTabs: () => 10,
          t: (key: string) => key,
          requestAgentReview: async () => 'batch-test',
        },
      }))
    })

    const frame = host.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame?.getAttribute('sandbox')).toBe('')
    act(() => { root.unmount() })
    host.remove()
  })

  it('keeps workspace HTML scripts inside an opaque-origin iframe', () => {
    const store = new TabsStore(() => 10)
    store.set(initialState('C:/work/proj'))
    store.navigate(store.getSnapshot().activeId as string, fileUrl('C:/work/proj', 'preview.html'))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(BrowserPanel, {
        store,
        deps: {
          defaultHome: () => 'https://www.bing.com',
          maxTabs: () => 10,
          t: (key: string) => key,
          requestAgentReview: async () => 'batch-test',
        },
      }))
    })

    const frame = host.querySelector('iframe') as HTMLIFrameElement | null
    const reviewButton = host.querySelector('button[aria-label="review.open"]') as HTMLButtonElement | null
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(reviewButton?.disabled).toBe(false)
    act(() => { root.unmount() })
    host.remove()
  })

  it('reviews a live workspace page without capturing or reloading it on entry', async () => {
    const comments: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/screenshot?')) {
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      if (url === '/api/dsh-browser/comments' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        const comment = {
          ...body,
          id: 'comment-1',
          status: 'draft',
          batchId: undefined,
          createdAt: 1,
          resolvedAt: undefined,
        }
        comments.push(comment)
        return new Response(JSON.stringify({ ok: true, value: comment }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, value: comments }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    })
    vi.stubGlobal('fetch', fetchMock)
    const requestAgentReview = vi.fn(async () => {
      for (const comment of comments) {
        comment.status = 'submitted'
        comment.batchId = 'batch-test'
      }
      return 'batch-test'
    })
    const store = new TabsStore(() => 10)
    store.set(initialState('C:/work/proj'))
    store.navigate(store.getSnapshot().activeId as string, fileUrl('C:/work/proj', 'preview.html'))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(BrowserPanel, {
        store,
        deps: {
          defaultHome: () => 'https://www.bing.com',
          maxTabs: () => 10,
          t: (key: string) => key,
          requestAgentReview,
        },
      }))
    })

    const reviewButton = host.querySelector('button[aria-label="review.open"]') as HTMLButtonElement
    await act(async () => { reviewButton.click() })
    const frame = host.querySelector('iframe') as HTMLIFrameElement
    const frameUrl = new URL(frame.getAttribute('src') ?? '', window.location.href)
    const reviewToken = frameUrl.searchParams.get('reviewToken') as string
    const postMessage = vi.spyOn(frame.contentWindow as Window, 'postMessage')
    const pickButton = [...host.querySelectorAll('button')]
      .find(button => button.textContent === 'review.pick') as HTMLButtonElement
    await act(async () => { pickButton.click() })
    const overlay = host.querySelector('[data-review-overlay]') as HTMLDivElement
    expect(postMessage).toHaveBeenCalledWith({
      source: 'dsh-browser-parent',
      kind: 'review-mode',
      reviewToken,
      enabled: true,
    }, '*')
    expect(host.querySelector('iframe')).toBe(frame)
    expect(vi.mocked(fetchMock).mock.calls.some(([input]) => String(input).includes('/screenshot?'))).toBe(false)

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          source: 'dsh-browser',
          kind: 'review-pick',
          reviewToken,
          target: {
            kind: 'element',
            selector: '#hero-title',
            textQuote: 'Nono',
            tagName: 'h1',
            attributes: { id: 'hero-title' },
            outerHTML: '<h1 id="hero-title">Nono</h1>',
            rect: { x: 50, y: 60, width: 200, height: 120 },
          },
          context: {
            viewportWidth: 800,
            viewportHeight: 600,
            devicePixelRatio: 1,
            scrollX: 0,
            scrollY: 900,
            documentWidth: 800,
            documentHeight: 1800,
          },
        },
      }))
    })

    const popover = host.querySelector('[data-review-popover]') as HTMLFormElement
    expect(popover).not.toBeNull()
    expect(Number.parseFloat(popover.style.top)).toBeCloseTo(20)
    expect(host.textContent).toContain('review.commentTitle')
    expect(overlay.getAttribute('data-picking')).toBeNull()
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          source: 'dsh-browser',
          kind: 'review-scroll',
          reviewToken,
          context: { scrollX: 0, scrollY: 1_000 },
        },
      }))
    })
    expect(Number.parseFloat(popover.style.top)).toBeCloseTo(3.33, 1)
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Reduce this region.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const addButton = [...host.querySelectorAll('button')]
      .find(button => button.textContent === 'review.add') as HTMLButtonElement
    await act(async () => { addButton.click() })
    expect(comments[0]).toMatchObject({
      target: { kind: 'element', selector: '#hero-title' },
      context: { scrollY: 900 },
    })
    expect(host.textContent).toContain('Reduce this region.')
    expect(host.querySelector('[data-review-region="1"]')).not.toBeNull()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const sendButton = [...host.querySelectorAll('button')]
      .find(button => button.textContent === 'review.send') as HTMLButtonElement
    await act(async () => { sendButton.click() })
    expect(requestAgentReview).toHaveBeenCalledWith(
      'C:/work/proj',
      ['comment-1'],
      [expect.objectContaining({ mediaType: 'image/png', data: 'AQID' })],
    )
    expect(host.textContent).not.toContain('Reduce this region.')
    expect(host.querySelector('[data-review-region="1"]')).toBeNull()
    expect(host.textContent).toContain('review.empty')
    confirm.mockRestore()
    act(() => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
  })

  it('falls back to live-page comments when screenshot capture is unavailable', async () => {
    const comments: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/screenshot?')) return new Response('missing', { status: 404 })
      if (url === '/api/dsh-browser/comments' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        const comment = {
          ...body,
          id: 'comment-live-1',
          status: 'draft',
          batchId: undefined,
          createdAt: 1,
          resolvedAt: undefined,
        }
        comments.push(comment)
        return new Response(JSON.stringify({ ok: true, value: comment }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, value: comments }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
    const requestAgentReview = vi.fn(async () => 'batch-test')
    const store = new TabsStore(() => 10)
    store.set(initialState('C:/work/proj'))
    store.navigate(store.getSnapshot().activeId as string, 'https://example.com/')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(BrowserPanel, {
        store,
        deps: {
          defaultHome: () => 'https://www.bing.com',
          maxTabs: () => 10,
          t: (key: string) => key,
          requestAgentReview,
        },
      }))
    })

    const reviewButton = host.querySelector('button[aria-label="review.open"]') as HTMLButtonElement
    await act(async () => { reviewButton.click() })
    const pickButton = [...host.querySelectorAll('button')]
      .find(button => button.textContent === 'review.pick') as HTMLButtonElement
    await act(async () => { pickButton.click() })

    const overlay = host.querySelector('[data-review-overlay]') as HTMLDivElement
    expect(overlay.getAttribute('data-picking')).toBe('true')
    expect(host.textContent).toContain('review.captureUnavailable')
    expect(host.textContent).not.toContain('screenshot failed: HTTP 404')

    overlay.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, toJSON: () => ({}),
    })
    const click = (type: string): MouseEvent => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 160, clientY: 120 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      return event
    }
    act(() => { overlay.dispatchEvent(click('pointerdown')) })
    act(() => { overlay.dispatchEvent(click('pointerup')) })
    const textarea = host.querySelector('[data-review-popover] textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Increase this heading size.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const addButton = [...host.querySelectorAll('button')]
      .find(button => button.textContent === 'review.add') as HTMLButtonElement
    await act(async () => { addButton.click() })
    expect(comments[0]).toMatchObject({
      target: { kind: 'region', rect: { x: 160, y: 120, width: 1, height: 1 } },
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const sendButton = [...host.querySelectorAll('button')]
      .find(button => button.textContent === 'review.send') as HTMLButtonElement
    await act(async () => { sendButton.click() })
    expect(requestAgentReview).toHaveBeenCalledWith('C:/work/proj', ['comment-live-1'], [])
    confirm.mockRestore()

    act(() => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
  })

  it('lets the user confirm and delete an unsubmitted review draft', async () => {
    let comments = [{
      id: 'comment-delete-1',
      workspaceRoot: 'C:/work/proj',
      url: fileUrl('C:/work/proj', 'preview.html'),
      tabId: 'tab-1',
      text: 'This comment was added by mistake.',
      target: {
        kind: 'region',
        selector: '',
        textQuote: '',
        tagName: 'region',
        attributes: {},
        outerHTML: '',
        rect: { x: 20, y: 30, width: 1, height: 1 },
      },
      context: { viewportWidth: 800, viewportHeight: 600, devicePixelRatio: 1 },
      status: 'draft',
      createdAt: 1,
    }]
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        const deleted = comments[0]
        comments = []
        return new Response(JSON.stringify({ ok: true, value: deleted }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, value: comments }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new TabsStore(() => 10)
    store.set(initialState('C:/work/proj'))
    store.navigate(store.getSnapshot().activeId as string, fileUrl('C:/work/proj', 'preview.html'))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(BrowserPanel, {
        store,
        deps: {
          defaultHome: () => 'https://www.bing.com',
          maxTabs: () => 10,
          t: (key: string) => key,
          requestAgentReview: async () => 'batch-test',
        },
      }))
    })

    const reviewButton = host.querySelector('button[aria-label="review.open"]') as HTMLButtonElement
    await act(async () => { reviewButton.click() })
    expect(host.textContent).toContain('This comment was added by mistake.')
    expect(host.querySelector('[data-review-region="1"]')).not.toBeNull()

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const deleteButton = [...host.querySelectorAll('button')]
      .find(button => button.textContent === 'review.delete') as HTMLButtonElement
    await act(async () => { deleteButton.click() })

    const deleteCall = vi.mocked(fetchMock).mock.calls.find(([, init]) => init?.method === 'DELETE')
    expect(deleteCall).toBeDefined()
    expect(host.textContent).not.toContain('This comment was added by mistake.')
    expect(host.querySelector('[data-review-region="1"]')).toBeNull()
    confirm.mockRestore()
    act(() => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
  })

  it('strictly sandboxes an absolute same-origin workspace file URL', () => {
    const store = new TabsStore(() => 10)
    store.set(initialState('C:/work/proj'))
    const url = new URL(fileUrl('C:/work/proj', 'unsafe.svg'), window.location.href).toString()
    store.navigate(store.getSnapshot().activeId as string, url)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(BrowserPanel, {
        store,
        deps: {
          defaultHome: () => 'https://www.bing.com',
          maxTabs: () => 10,
          t: (key: string) => key,
          requestAgentReview: async () => 'batch-test',
        },
      }))
    })

    const frame = host.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame?.getAttribute('sandbox')).toBe('')
    act(() => { root.unmount() })
    host.remove()
  })

  it('ignores non-http navigation messages from proxied page scripts', () => {
    const store = new TabsStore(() => 10)
    store.set(initialState('C:/work/proj'))
    store.openTab('https://example.com/')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(BrowserPanel, {
        store,
        deps: {
          defaultHome: () => 'https://www.bing.com',
          maxTabs: () => 10,
          t: (key: string) => key,
          requestAgentReview: async () => 'batch-test',
        },
      }))
    })

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { source: 'dsh-browser', kind: 'navigate', url: 'javascript:alert(1)' },
      }))
    })
    expect(store.activeTab()?.url).toBe('https://example.com/')

    act(() => { root.unmount() })
    host.remove()
  })
})
