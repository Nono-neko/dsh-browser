import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { reviewBridgeScript } from '../src/host/review-bridge.ts'

describe('workspace live-review bridge', () => {
  it('activates in place and reports the clicked DOM target with page context', () => {
    const token = 'abcDEF0123456789'
    const markup = reviewBridgeScript(token, 'nonce-value')
    const code = /<script[^>]*>([\s\S]*)<\/script>/.exec(markup)?.[1]
    if (code === undefined) throw new Error('review bridge script missing')

    const messages: Array<Record<string, unknown>> = []
    const windowListeners = new Map<string, (event: Record<string, unknown>) => void>()
    const documentListeners = new Map<string, (event: Record<string, unknown>) => void>()
    const animationFrames: Array<() => void> = []
    let reviewActive = false
    const root = {
      scrollWidth: 1280,
      scrollHeight: 2400,
      setAttribute: (name: string) => { if (name === 'data-dsh-browser-review-active') reviewActive = true },
      removeAttribute: (name: string) => { if (name === 'data-dsh-browser-review-active') reviewActive = false },
    }
    const parent = { postMessage: (value: Record<string, unknown>) => { messages.push(value) } }
    const element = {
      id: 'hero-title',
      nodeType: 1,
      tagName: 'H1',
      textContent: ' Nono  title ',
      outerHTML: '<h1 id="hero-title">Nono title</h1>',
      parentElement: null,
      attributes: [{ name: 'id', value: 'hero-title' }],
      getAttribute: (name: string) => name === 'data-source-file' ? 'src/App.tsx' : name === 'data-source-line' ? '12' : null,
      getBoundingClientRect: () => ({ left: 50, top: 60, width: 200, height: 80 }),
    }
    const pageWindow = {
      parent,
      CSS: { escape: (value: string) => value },
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 2,
      scrollX: 0,
      scrollY: 900,
      addEventListener: (kind: string, listener: (event: Record<string, unknown>) => void) => {
        windowListeners.set(kind, listener)
      },
    }
    const pageDocument = {
      documentElement: root,
      body: { scrollWidth: 800, scrollHeight: 1800 },
      head: { appendChild: vi.fn() },
      createElement: () => ({ textContent: '' }),
      elementFromPoint: () => element,
      addEventListener: (kind: string, listener: (event: Record<string, unknown>) => void) => {
        documentListeners.set(kind, listener)
      },
    }

    runInNewContext(code, {
      window: pageWindow,
      document: pageDocument,
      CSS: pageWindow.CSS,
      requestAnimationFrame: (callback: () => void) => { animationFrames.push(callback); return animationFrames.length },
    })

    windowListeners.get('message')?.({
      source: parent,
      data: { source: 'dsh-browser-parent', kind: 'review-mode', reviewToken: token, enabled: true },
    })
    expect(reviewActive).toBe(true)

    const preventDefault = vi.fn()
    const stopImmediatePropagation = vi.fn()
    documentListeners.get('pointerdown')?.({
      button: 0,
      target: element,
      clientX: 80,
      clientY: 90,
      cancelable: true,
      preventDefault,
      stopImmediatePropagation,
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(stopImmediatePropagation).toHaveBeenCalled()
    expect(reviewActive).toBe(false)
    expect(messages).toContainEqual(expect.objectContaining({
      source: 'dsh-browser',
      kind: 'review-pick',
      reviewToken: token,
      target: expect.objectContaining({
        kind: 'element',
        selector: '#hero-title',
        textQuote: 'Nono title',
        source: { file: 'src/App.tsx', line: 12, column: undefined },
        rect: { x: 80, y: 90, width: 1, height: 1 },
      }),
      context: expect.objectContaining({
        viewportWidth: 800,
        viewportHeight: 600,
        scrollY: 900,
        documentHeight: 2400,
      }),
    }))
  })

  it('does not emit a bridge for an invalid capability token', () => {
    expect(reviewBridgeScript('short')).toBe('')
    expect(reviewBridgeScript(undefined)).toBe('')
  })
})
