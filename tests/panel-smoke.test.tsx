import { describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserPanel } from '../src/client/panel/BrowserPanel.tsx'
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
        },
      }))
    })
    const frame = host.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame).not.toBeNull()
    expect(frame?.getAttribute('src')).toBe('https://example.com/')
    act(() => { root.unmount() })
    host.remove()
  })
})
