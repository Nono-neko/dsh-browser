import { describe, expect, it } from 'vitest'
import { initialState, makeTab, START_URL, TabsStore } from '../src/client/store.ts'

function storeWith(maxTabs = 10): TabsStore {
  return new TabsStore(() => maxTabs)
}

describe('TabsStore', () => {
  it('starts with one start tab per root', () => {
    const store = storeWith()
    store.set(initialState('C:/work/proj'))
    const { tabs, activeId, root } = store.getSnapshot()
    expect(root).toBe('C:/work/proj')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].url).toBe(START_URL)
    expect(activeId).toBe(tabs[0].id)
  })

  it('navigates and pushes the history stack', () => {
    const store = storeWith()
    store.set(initialState('root'))
    const id = store.getSnapshot().activeId as string
    store.navigate(id, 'https://a.example/1')
    store.navigate(id, 'https://a.example/2')
    const tab = store.getSnapshot().tabs[0]
    expect(tab.url).toBe('https://a.example/2')
    expect(tab.stack).toEqual(['https://a.example/1', 'https://a.example/2'])
    expect(tab.index).toBe(1)
  })

  it('walks back and forward through the stack', () => {
    const store = storeWith()
    store.set(initialState('root'))
    const id = store.getSnapshot().activeId as string
    store.navigate(id, 'https://a.example/1')
    store.navigate(id, 'https://a.example/2')
    store.back(id)
    expect(store.getSnapshot().tabs[0].url).toBe('https://a.example/1')
    expect(store.canBack(id)).toBe(false)
    expect(store.canForward(id)).toBe(true)
    store.forward(id)
    expect(store.getSnapshot().tabs[0].url).toBe('https://a.example/2')
  })

  it('updates the tab label while walking history', () => {
    const store = storeWith()
    store.set(initialState('root'))
    const id = store.getSnapshot().activeId as string
    store.navigate(id, 'https://first.example/page')
    store.navigate(id, 'https://second.example/page')

    store.back(id)
    expect(store.getSnapshot().tabs[0].label).toBe('first.example/page')
    store.forward(id)
    expect(store.getSnapshot().tabs[0].label).toBe('second.example/page')
  })

  it('navigating after going back truncates the forward history', () => {
    const store = storeWith()
    store.set(initialState('root'))
    const id = store.getSnapshot().activeId as string
    store.navigate(id, 'https://a.example/1')
    store.navigate(id, 'https://a.example/2')
    store.back(id)
    store.navigate(id, 'https://a.example/3')
    const tab = store.getSnapshot().tabs[0]
    expect(tab.stack).toEqual(['https://a.example/1', 'https://a.example/3'])
    expect(tab.index).toBe(1)
  })

  it('dedupes opening the same URL onto the existing tab', () => {
    const store = storeWith()
    store.set(initialState('root'))
    store.openTab('https://a.example/x')
    store.openTab('https://a.example/y')
    store.openTab('https://a.example/x')
    expect(store.getSnapshot().tabs).toHaveLength(3) // start + x + y
    expect(store.getSnapshot().activeId).toBe(store.getSnapshot().tabs[1].id)
  })

  it('trims the oldest inactive tab beyond the cap', () => {
    const store = storeWith(3)
    store.set(initialState('root'))
    store.openTab('https://a.example/1')
    store.openTab('https://a.example/2')
    store.openTab('https://a.example/3')
    const { tabs, activeId } = store.getSnapshot()
    expect(tabs).toHaveLength(3)
    expect(tabs.some(tab => tab.id === activeId)).toBe(true)
  })

  it('closing the active tab activates a neighbor', () => {
    const store = storeWith()
    store.set(initialState('root'))
    store.openTab('https://a.example/1')
    const id = store.getSnapshot().activeId as string
    store.openTab('https://a.example/2')
    store.closeTab(id)
    const { tabs, activeId: active } = store.getSnapshot()
    expect(tabs.some(tab => tab.id === id)).toBe(false)
    expect(active).toBeDefined()
    expect(tabs.some(tab => tab.id === active)).toBe(true)
  })

  it('closing the last tab yields a fresh start tab', () => {
    const store = storeWith()
    store.set(initialState('root'))
    const id = store.getSnapshot().activeId as string
    store.closeTab(id)
    const { tabs, activeId } = store.getSnapshot()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].url).toBe(START_URL)
    expect(activeId).toBe(tabs[0].id)
  })

  it('reload bumps the iframe nonce', () => {
    const store = storeWith()
    store.set(initialState('root'))
    const id = store.getSnapshot().activeId as string
    store.navigate(id, 'https://a.example/1')
    const before = store.getSnapshot().tabs[0].nonce
    store.reload(id)
    expect(store.getSnapshot().tabs[0].nonce).toBe(before + 1)
  })

  it('restores tabs from a persisted shape', () => {
    const store = storeWith()
    const tab = makeTab('https://a.example/restored')
    store.set({
      root: 'root',
      tabs: [{ ...tab, stack: ['https://a.example/restored'], index: 0 }],
      activeId: tab.id,
    })
    expect(store.getSnapshot().tabs[0].url).toBe('https://a.example/restored')
  })

  it('enforces the tab cap while replacing restored state', () => {
    const store = storeWith(2)
    const first = makeTab('https://a.example/1')
    const second = makeTab('https://a.example/2')
    const active = makeTab('https://a.example/3')

    store.set({ root: 'root', tabs: [first, second, active], activeId: active.id })

    expect(store.getSnapshot().tabs.map(tab => tab.id)).toEqual([second.id, active.id])
    expect(store.getSnapshot().activeId).toBe(active.id)
  })

  it('enforces a lower live tab cap immediately', () => {
    let maxTabs = 3
    const store = new TabsStore(() => maxTabs)
    const first = makeTab('https://a.example/1')
    const second = makeTab('https://a.example/2')
    const active = makeTab('https://a.example/3')
    store.set({ root: 'root', tabs: [first, second, active], activeId: active.id })

    maxTabs = 2
    store.enforceLimit()

    expect(store.getSnapshot().tabs.map(tab => tab.id)).toEqual([second.id, active.id])
  })
})
