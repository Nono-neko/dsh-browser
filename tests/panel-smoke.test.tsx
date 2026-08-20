import { describe, expect, it } from 'vitest'
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
        },
      }))
    })
    const frame = host.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame).not.toBeNull()
    expect(frame?.getAttribute('src')).toBe(url)
    expect(frame?.hasAttribute('sandbox')).toBe(false)
    act(() => { root.unmount() })
    host.remove()
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
        },
      }))
    })

    const frame = host.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame?.getAttribute('sandbox')).toBe('')
    act(() => { root.unmount() })
    host.remove()
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
        },
      }))
    })

    const frame = host.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame?.getAttribute('sandbox')).toBe('')
    act(() => { root.unmount() })
    host.remove()
  })
})
