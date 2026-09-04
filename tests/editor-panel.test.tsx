import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorPanel } from '../src/client/panel/EditorPanel.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('EditorPanel image preview', () => {
  it('opens a common image through the workspace file route without source decoding', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requests.push(url)
      return new Response(JSON.stringify({
        ok: true,
        value: { root: 'C:/work/project', path: '', entries: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(createElement(EditorPanel, {
        root: 'C:/work/project',
        target: { path: 'assets/avatar.PNG', line: undefined },
        t: (key: string) => key,
        onDirtyChange: () => {},
        onClose: () => {},
      }))
      await Promise.resolve()
    })

    const image = host.querySelector('img')
    expect(image?.getAttribute('src')).toContain('/api/dsh-browser/file?')
    expect(image?.getAttribute('src')).toContain('path=assets%2Favatar.PNG')
    expect(requests.some(url => url.includes('/api/dsh-browser/source'))).toBe(false)

    act(() => { root.unmount() })
    host.remove()
  })
})
