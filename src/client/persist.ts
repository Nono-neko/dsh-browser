/**
 * localStorage persistence for the tabs store: one key per workspace root, a
 * debounced writer plus a pagehide flush (a close/background never drops the
 * last writes).
 * @module dsh-browser/client/persist
 */

import type { PersistedTabs, TabsState } from './store.ts'

const KEY_PREFIX = 'dsh.browser.v1.'
const DEBOUNCE_MS = 150

function keyFor(root: string): string {
  return `${KEY_PREFIX}${root}`
}

/** Serialize the persistable slice of a tabs state. */
export function serializeState(state: TabsState): PersistedTabs {
  return {
    tabs: state.tabs.map(tab => ({
      id: tab.id,
      url: tab.url,
      label: tab.label,
      stack: tab.stack,
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
    const parsed = JSON.parse(raw) as Partial<PersistedTabs>
    if (!Array.isArray(parsed.tabs)) return undefined
    return {
      tabs: parsed.tabs.filter(tab =>
        typeof tab === 'object' && tab !== null
        && typeof tab.id === 'string' && typeof tab.url === 'string',
      ),
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : undefined,
    }
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

/** Create the debounced persister with the given storage backend. */
export function createTabPersist(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): TabPersist {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: TabsState | undefined

  const write = (): void => {
    if (pending === undefined) return
    const state = pending
    pending = undefined
    if (state.root === '') return
    try {
      storage.setItem(keyFor(state.root), JSON.stringify(serializeState(state)))
    } catch {
      // Quota / privacy-mode failures are best-effort.
    }
  }

  return {
    save(state) {
      pending = state
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
      pending = undefined
    },
  }
}
