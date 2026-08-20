/**
 * Tabs store: the browser panel's state owner. One state per workspace root —
 * tabs, their address-bar history stacks, and the active tab. Framework-free
 * snapshot/subscribe surface (mirrors the family's controller style); no
 * external state library.
 * @module dsh-browser/client/store
 */

import { displayLabel } from '../core/url.ts'

/** The start-page pseudo URL (no iframe is mounted for it). */
export const START_URL = 'start'

export interface BrowserTab {
  id: string
  /** START_URL or an http(s) / workspace-file URL. */
  url: string
  label: string
  /** Address-bar-initiated history (cross-origin in-page clicks are invisible). */
  stack: string[]
  index: number
  /** Bumped on reload so the iframe remounts. */
  nonce: number
}

export interface TabsState {
  root: string
  tabs: BrowserTab[]
  activeId: string | undefined
}

export interface PersistedTabs {
  tabs: Array<Pick<BrowserTab, 'id' | 'url' | 'label' | 'stack' | 'index'>>
  activeId: string | undefined
}

let counter = 0

/** One unique tab id (page-local monotonic counter). */
export function nextTabId(): string {
  counter += 1
  return `tab-${Date.now().toString(36)}-${counter.toString(36)}`
}

export function makeTab(url: string): BrowserTab {
  return {
    id: nextTabId(),
    url,
    label: url === START_URL ? 'start' : displayLabel(url),
    stack: url === START_URL ? [] : [url],
    index: url === START_URL ? -1 : 0,
    nonce: 0,
  }
}

/** The empty state for one root: a single start tab. */
export function initialState(root: string): TabsState {
  const tab = makeTab(START_URL)
  tab.label = ''
  return { root, tabs: [tab], activeId: tab.id }
}

export class TabsStore {
  private state: TabsState
  private listeners = new Set<() => void>()

  constructor(private readonly maxTabs: () => number) {
    this.state = initialState('')
  }

  getSnapshot(): TabsState {
    return this.state
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Replace the whole state (root switch / restore) and notify once. */
  set(state: TabsState): void {
    this.state = { ...state, tabs: this.limitTabs(state.tabs, state.activeId) }
    this.notify()
  }

  activeTab(): BrowserTab | undefined {
    const { tabs, activeId } = this.state
    return tabs.find(tab => tab.id === activeId)
  }

  openTab(url: string): void {
    const { tabs } = this.state
    let tab = tabs.find(existing => existing.url === url)
    if (tab === undefined) {
      tab = makeTab(url)
      tabs.push(tab)
    }
    this.trim()
    this.state = { ...this.state, activeId: tab.id }
    this.notify()
  }

  newTab(): void {
    const tab = makeTab(START_URL)
    tab.label = ''
    this.state = { ...this.state, tabs: [...this.state.tabs, tab], activeId: tab.id }
    this.trim()
    this.notify()
  }

  closeTab(id: string): void {
    const { tabs, activeId } = this.state
    const index = tabs.findIndex(tab => tab.id === id)
    if (index < 0) return
    const remaining = tabs.filter(tab => tab.id !== id)
    const next = remaining.length > 0 ? remaining : [this.startTab()]
    let nextActive = activeId
    if (activeId === id) {
      const neighbor = next[Math.min(index, next.length - 1)]
      nextActive = neighbor?.id
    }
    this.state = { ...this.state, tabs: next, activeId: nextActive ?? next[0]?.id }
    this.notify()
  }

  activate(id: string): void {
    if (this.state.tabs.some(tab => tab.id === id)) {
      this.state = { ...this.state, activeId: id }
      this.notify()
    }
  }

  navigate(id: string, url: string): void {
    const tab = this.state.tabs.find(entry => entry.id === id)
    if (tab === undefined) return
    const stack = [...tab.stack.slice(0, tab.index + 1), url]
    this.replaceTab({ ...tab, url, label: displayLabel(url), stack, index: stack.length - 1 })
  }

  back(id: string): void {
    const tab = this.state.tabs.find(entry => entry.id === id)
    if (tab === undefined || tab.index <= 0) return
    const index = tab.index - 1
    const url = tab.stack[index]
    this.replaceTab({ ...tab, url, label: displayLabel(url), index })
  }

  forward(id: string): void {
    const tab = this.state.tabs.find(entry => entry.id === id)
    if (tab === undefined || tab.index >= tab.stack.length - 1) return
    const index = tab.index + 1
    const url = tab.stack[index]
    this.replaceTab({ ...tab, url, label: displayLabel(url), index })
  }

  reload(id: string): void {
    const tab = this.state.tabs.find(entry => entry.id === id)
    if (tab === undefined) return
    this.replaceTab({ ...tab, nonce: tab.nonce + 1 })
  }

  canBack(id: string): boolean {
    const tab = this.state.tabs.find(entry => entry.id === id)
    return tab !== undefined && tab.index > 0
  }

  canForward(id: string): boolean {
    const tab = this.state.tabs.find(entry => entry.id === id)
    return tab !== undefined && tab.index < tab.stack.length - 1
  }

  /** Apply the current live tab cap and notify only when tabs were removed. */
  enforceLimit(): void {
    const tabs = this.limitTabs(this.state.tabs, this.state.activeId)
    if (tabs === this.state.tabs) return
    this.state = { ...this.state, tabs }
    this.notify()
  }

  private replaceTab(next: BrowserTab): void {
    this.state = {
      ...this.state,
      tabs: this.state.tabs.map(tab => (tab.id === next.id ? next : tab)),
    }
    this.notify()
  }

  /** Drop the oldest tabs beyond the configured cap (never the active one). */
  private trim(): void {
    const { tabs, activeId } = this.state
    const limited = this.limitTabs(tabs, activeId)
    if (limited !== tabs) this.state = { ...this.state, tabs: limited }
  }

  private limitTabs(tabs: BrowserTab[], activeId: string | undefined): BrowserTab[] {
    const max = Math.max(2, this.maxTabs())
    if (tabs.length <= max) return tabs
    const limited = [...tabs]
    while (limited.length > max) {
      const index = limited.findIndex(tab => tab.id !== activeId)
      limited.splice(index >= 0 ? index : 0, 1)
    }
    return limited
  }

  /** A fresh start tab (used when the last real tab closes). */
  private startTab(): BrowserTab {
    const tab = makeTab(START_URL)
    tab.label = ''
    return tab
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}
