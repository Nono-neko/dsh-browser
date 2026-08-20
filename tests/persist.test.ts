import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindTabPersistPagehide, createTabPersist, readPersisted } from '../src/client/persist.ts'
import { initialState } from '../src/client/store.ts'

const KEY = 'dsh.browser.v1.root'

function validTab(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tab-1',
    url: 'https://example.com/',
    label: 'example.com',
    stack: ['https://example.com/'],
    index: 0,
    ...overrides,
  }
}

describe('tab persistence restore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a tab whose history stack is malformed', () => {
    localStorage.setItem(KEY, JSON.stringify({
      tabs: [{
        id: 'tab-1',
        url: 'https://example.com/',
        label: 'example.com',
        stack: null,
        index: 0,
      }],
      activeId: 'tab-1',
    }))

    expect(readPersisted('root')).toBeUndefined()
  })

  it('repairs an active id that does not name a restored tab', () => {
    localStorage.setItem(KEY, JSON.stringify({
      tabs: [{
        id: 'tab-1',
        url: 'https://example.com/',
        label: 'example.com',
        stack: ['https://example.com/'],
        index: 0,
      }],
      activeId: 'missing',
    }))

    expect(readPersisted('root')?.activeId).toBe('tab-1')
  })

  it.each([
    ['a missing label', { id: 'tab-1', url: 'https://example.com/', stack: ['https://example.com/'], index: 0 }],
    ['an out-of-range history index', validTab({ index: 2 })],
    ['a URL inconsistent with its history', validTab({ url: 'https://other.example/' })],
    ['a start-page entry inside real navigation history', validTab({ stack: ['start', 'https://example.com/'], index: 1 })],
    ['an executable URL scheme', validTab({ url: 'javascript:alert(1)', stack: ['javascript:alert(1)'] })],
  ])('rejects a tab with %s', (_description, tab) => {
    localStorage.setItem(KEY, JSON.stringify({ tabs: [tab], activeId: 'tab-1' }))

    expect(readPersisted('root')).toBeUndefined()
  })

  it('drops duplicate tab ids while retaining the first valid record', () => {
    localStorage.setItem(KEY, JSON.stringify({
      tabs: [
        validTab(),
        validTab({
          url: 'https://other.example/',
          label: 'other.example',
          stack: ['https://other.example/'],
        }),
      ],
      activeId: 'tab-1',
    }))

    expect(readPersisted('root')?.tabs).toEqual([validTab()])
  })

  it('keeps pending writes for every workspace root', () => {
    vi.useFakeTimers()
    const values = new Map<string, string>()
    const persist = createTabPersist({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
    })

    persist.save(initialState('root-a'))
    persist.save(initialState('root-b'))
    vi.advanceTimersByTime(150)

    expect(values.has('dsh.browser.v1.root-a')).toBe(true)
    expect(values.has('dsh.browser.v1.root-b')).toBe(true)
  })

  it('flushes pending tabs when the page is hidden', () => {
    vi.useFakeTimers()
    const values = new Map<string, string>()
    const persist = createTabPersist({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
    })
    const dispose = bindTabPersistPagehide(persist)
    persist.save(initialState('root'))

    window.dispatchEvent(new Event('pagehide'))

    expect(values.has(KEY)).toBe(true)
    dispose()
  })
})
