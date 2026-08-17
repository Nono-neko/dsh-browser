/**
 * Panel view mounting.
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so the panel takes over the center column at
 * the DOM level: a container is appended inside the center column
 * (`[class*="centerCol"]`, the 0.1.0-rc.6+ AppFrame layout; previously
 * `[data-pane="conversation"]` on older shells — the mount selector keeps
 * both) as an extra trailing child React never manages, and a stylesheet rule
 * hides the conversation content while the panel is active. Toggling is a
 * data attribute on <html> — no React involvement, so the conversation
 * subtree underneath stays mounted and stateful.
 *
 * Adapted from the dsh-web-ui family's dsh-ssh panel mount (Apache-2.0).
 * @module dsh-browser/client/mount
 */

import { createRoot, type Root } from 'react-dom/client'
import type { PanelController } from './controller.ts'
import type { TabsStore } from './store.ts'
import { BrowserPanel } from './panel/BrowserPanel.tsx'
import css from './panel/panel.module.css'

/** The injected panel container (kept in the DOM, hidden when inactive). */
export const PANEL_VIEW_SELECTOR = '[data-dsh-browser-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-browser-active'
/** Sibling panels' activation attributes, removed when this panel opens. */
const OTHER_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'browser'

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

export interface BrowserPanelDeps {
  /** Home button target (live settings read). */
  defaultHome: () => string
  /** Tab cap (live settings read). */
  maxTabs: () => number
  /** Locale-bound translate for the panel copy. */
  t: (key: string) => string
}

/**
 * Mount the panel React tree into the center column and bind its visibility
 * to the controller's panelOpen state.
 * @param controller - the panel controller driving the view.
 * @param store - the tabs store the panel renders.
 * @param deps - live settings reads.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountPanel(controller: PanelController, store: TabsStore, deps: BrowserPanelDeps): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      // The conversation pane was replaced; drop the stale tree and remount.
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshBrowserView = ''
    container.className = css.view
    column.appendChild(container)
    root = createRoot(container)
    root.render(<BrowserPanel store={store} deps={deps} />)
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (controller.getSnapshot().panelOpen) {
      // Single-occupant center column: opening this panel must evict sibling
      // panels (task board / ssh), both their html attributes and their
      // controller state, otherwise the panels' visibility rules fight.
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if ((detail === 'taskboard' || detail === 'ssh') && controller.getSnapshot().panelOpen) {
      controller.close()
    }
  }
  // Jump out on sidebar context clicks: clicking a session/workspace row
  // hands the center column back to the conversation. Capture phase, so the
  // panel closes before the shell processes the click.
  const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().panelOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
