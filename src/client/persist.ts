/**
 * localStorage persistence for the tabs store: one key per workspace root, a
 * debounced writer plus a pagehide flush (a close/background never drops the
 * last writes).
 * @module dsh-browser/client/persist
 */

import { tryParseHttp } from '../core/url.ts'
import { START_URL, type PersistedTabs, type TabsState } from './store.ts'

const KEY_PREFIX = 'dsh.browser.v1.'
const DEBOUNCE_MS = 150

function keyFor(root: string): string {
  return `${KEY_PREFIX}${root}`
}

type PersistedTab = PersistedTabs['tabs'][number]

/** Whether a stored URL is one the panel itself can create. */
function isRestorableUrl(value: string): boolean {
  if (value === START_URL || tryParseHttp(value) !== null) return true
  if (!value.startsWith('/')) return false
  try {
    const parsed = new URL(value, 'http://dsh.local')
    return parsed.pathname === '/api/dsh-browser/file'
      && parsed.searchParams.get('root') !== null
      && parsed.searchParams.get('root') !== ''
      && parsed.searchParams.get('path') !== null
      && parsed.searchParams.get('path') !== ''
  } catch {
    return false
  }
}

/** Parse one complete tab record, rejecting structurally inconsistent data. */
function parseTab(value: unknown): PersistedTab | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const tab = value as Record<string, unknown>
  if (typeof tab.id !== 'string' || tab.id === '') return undefined
  if (typeof tab.url !== 'string' || !isRestorableUrl(tab.url)) return undefined
  if (typeof tab.label !== 'string') return undefined
  if (!Array.isArray(tab.stack) || !tab.stack.every(entry => typeof entry === 'string' && isRestorableUrl(entry))) {
    return undefined
  }
  if (!Number.isInteger(tab.index)) return undefined
  const index = tab.index as number
  if (tab.url === START_URL) {
    if (tab.stack.length !== 0 || index !== -1) return undefined
  } else if (tab.stack.includes(START_URL) || index < 0 || index >= tab.stack.length || tab.stack[index] !== tab.url) {
    return undefined
  }
  return {
    id: tab.id,
    url: tab.url,
    label: tab.label,
    stack: [...tab.stack] as string[],
    index,
  }
}

/** Serialize the persistable slice of a tabs state. */
export function serializeState(state: TabsState): PersistedTabs {
  return {
    tabs: state.tabs.map(tab => ({
      id: tab.id,
      url: tab.url,
      label: tab.label,
      stack: [...tab.stack],
      index: tab.index,
    })),
    activeId: state.activeId,
  }
}

/** Read the persisted tabs for one root; undefined when nothing was stored. */
export function readPersisted(root: string): PersistedTabs | undefined {
  if (root === '') return undefined
  try {
    const raw = localStorage.getItem(keyFor(root))
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown }
    if (!Array.isArray(parsed.tabs)) return undefined
    const seen = new Set<string>()
    const tabs: PersistedTab[] = []
    for (const candidate of parsed.tabs) {
      const tab = parseTab(candidate)
      if (tab === undefined || seen.has(tab.id)) continue
      seen.add(tab.id)
      tabs.push(tab)
    }
    if (tabs.length === 0) return undefined
    const activeId = typeof parsed.activeId === 'string' && seen.has(parsed.activeId)
      ? parsed.activeId
      : tabs[0].id
    return { tabs, activeId }
  } catch {
    return undefined
  }
}

export interface TabPersist {
  /** Schedule a write for the given root (debounced). */
  save(state: TabsState): void
  /** Flush the pending write immediately (pagehide / visibility change). */
  flush(): void
  /** Drop pending timers (plugin teardown). */
  dispose(): void
}

interface PagehideTarget {
  addEventListener(type: 'pagehide', listener: () => void): void
  removeEventListener(type: 'pagehide', listener: () => void): void
}

/** Flush pending tab writes before the browser freezes or discards the page. */
export function bindTabPersistPagehide(
  persist: Pick<TabPersist, 'flush'>,
  target: PagehideTarget = window,
): () => void {
  const flush = (): void => { persist.flush() }
  target.addEventListener('pagehide', flush)
  return () => { target.removeEventListener('pagehide', flush) }
}

/** Create the debounced persister with the given storage backend. */
export function createTabPersist(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): TabPersist {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<string, PersistedTabs>()

  const write = (): void => {
    timer = undefined
    const batch = [...pending]
    pending.clear()
    for (const [root, state] of batch) {
      try {
        storage.setItem(keyFor(root), JSON.stringify(state))
      } catch {
        // Quota / privacy-mode failures are best-effort.
      }
    }
  }

  return {
    save(state) {
      if (state.root === '') return
      pending.set(state.root, serializeState(state))
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(write, DEBOUNCE_MS)
    },
    flush() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      write()
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending.clear()
    },
  }
}
