/**
 * The browser panel: tab strip, toolbar (back/forward/reload/home/external),
 * address bar, and the tab content area. Inactive tab frames stay mounted
 * (stateful) but hidden; iframes lazy-load on first activation so a restored
 * tab set does not fire every network request at once.
 * @module dsh-browser/client/panel/BrowserPanel
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { normalizeAddress, displayLabel, toProxyUrl } from '../../core/url.ts'
import { START_URL, type BrowserTab, type TabsStore } from '../store.ts'
import type { BrowserPanelDeps } from '../mount.tsx'
import { StartPage } from './StartPage.tsx'
import css from './panel.module.css'

interface BrowserPanelProps {
  store: TabsStore
  deps: BrowserPanelDeps
}

function isWorkspaceFileUrl(value: string): boolean {
  try {
    const url = new URL(value, window.location.href)
    return url.origin === window.location.origin && url.pathname === '/api/dsh-browser/file'
  } catch {
    return false
  }
}

export function BrowserPanel({ store, deps }: BrowserPanelProps): JSX.Element {
  const subscribe = useMemo(() => store.subscribe.bind(store), [store])
  const state = useSyncExternalStore(subscribe, () => store.getSnapshot())
  const t = deps.t
  const [draft, setDraft] = useState('')
  const seen = useRef(new Set<string>())

  const active = state.tabs.find(tab => tab.id === state.activeId)
  useEffect(() => {
    if (active !== undefined) seen.current.add(active.id)
    setDraft(active !== undefined && active.url !== START_URL ? active.url : '')
  }, [active?.id, active?.url])

  // Links clicked inside a proxied iframe post their URL here instead of
  // opening the system browser. _blank / window.open opens a new tab;
  // ordinary links navigate the active tab.
  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const data = event.data
      if (data === null || typeof data !== 'object' || data.source !== 'dsh-browser') return
      const url = typeof data.url === 'string' ? data.url : ''
      if (url === '') return
      if (data.kind === 'open') {
        store.openTab(url)
      } else if (data.kind === 'navigate') {
        const current = store.activeTab()
        if (current !== undefined) store.navigate(current.id, url)
        else store.openTab(url)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [store])

  const submitAddress = (): void => {
    if (active === undefined) return
    const url = normalizeAddress(draft)
    if (url === null) return
    store.navigate(active.id, url)
  }

  const label = (tab: BrowserTab): string => {
    if (tab.url === START_URL) return tab.label !== '' ? tab.label : t('start.title')
    return tab.label !== '' ? tab.label : displayLabel(tab.url)
  }

  return (
    <div className={css.panel}>
      <div className={css.tabStrip} role="tablist">
        {state.tabs.map(tab => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === state.activeId}
            className={tab.id === state.activeId ? css.tab + ' ' + css.tabActive : css.tab}
            data-active={tab.id === state.activeId ? 'true' : undefined}
            onClick={() => { store.activate(tab.id) }}
            title={tab.url === START_URL ? undefined : tab.url}
          >
            <span className={css.tabLabel}>{label(tab)}</span>
            <button
              type="button"
              className={css.tabClose}
              aria-label={t('tabs.close')}
              title={t('tabs.close')}
              onClick={(event) => {
                event.stopPropagation()
                store.closeTab(tab.id)
              }}
            >
              <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>
            </button>
          </div>
        ))}
        <button
          type="button"
          className={css.newTab}
          aria-label={t('tabs.new')}
          title={t('tabs.new')}
          onClick={() => { store.newTab() }}
        >
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M6 2v8M2 6h8"/></svg>
        </button>
      </div>

      <div className={css.toolbar}>
        <button
          type="button"
          className={css.toolButton}
          disabled={active === undefined || !store.canBack(active.id)}
          aria-label={t('toolbar.back')}
          title={t('toolbar.back')}
          onClick={() => { if (active !== undefined) store.back(active.id) }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3L5.5 8l4.5 5"/></svg>
        </button>
        <button
          type="button"
          className={css.toolButton}
          disabled={active === undefined || !store.canForward(active.id)}
          aria-label={t('toolbar.forward')}
          title={t('toolbar.forward')}
          onClick={() => { if (active !== undefined) store.forward(active.id) }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3l4.5 5L6 13"/></svg>
        </button>
        <button
          type="button"
          className={css.toolButton}
          disabled={active === undefined || active.url === START_URL}
          aria-label={t('toolbar.reload')}
          title={t('toolbar.reload')}
          onClick={() => { if (active !== undefined) store.reload(active.id) }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5V5h-2.5"/></svg>
        </button>
        <button
          type="button"
          className={css.toolButton}
          aria-label={t('toolbar.home')}
          title={t('toolbar.home')}
          onClick={() => {
            if (active !== undefined) {
              const home = normalizeAddress(deps.defaultHome()) ?? 'https://www.bing.com'
              store.navigate(active.id, home)
            }
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8L8 3l5.5 5"/><path d="M4.5 6.8V13h7V6.8"/></svg>
        </button>
        <input
          className={css.address}
          type="text"
          spellCheck={false}
          value={draft}
          placeholder={t('address.placeholder')}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submitAddress()
            }
          }}
        />
        <button
          type="button"
          className={css.toolButton}
          disabled={active === undefined || active.url === START_URL}
          aria-label={t('toolbar.openExternal')}
          title={t('toolbar.openExternal')}
          onClick={() => {
            if (active !== undefined && active.url !== START_URL) {
              window.open(active.url, '_blank', 'noopener')
            }
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.5 9.5L13 3"/><path d="M9 3h4v4"/><path d="M12 9v3.5H3.5V4H8"/></svg>
        </button>
      </div>

      <div className={css.content}>
        {state.tabs.map(tab => {
          const isActive = tab.id === state.activeId
          const isStart = tab.url === START_URL
          const mounted = isActive || seen.current.has(tab.id)
          return (
            <div
              key={tab.id}
              className={css.tabPane}
              data-visible={isActive ? 'true' : undefined}
            >
              {isStart ? (
                <StartPage root={state.root} t={t} onNavigate={(url) => { store.navigate(tab.id, url) }} onOpenFile={(url) => { store.openTab(url) }} />
              ) : mounted ? (
                <iframe
                  key={`${tab.id}:${tab.nonce}`}
                  className={css.frame}
                  src={toProxyUrl(tab.url)}
                  title={label(tab)}
                  sandbox={isWorkspaceFileUrl(tab.url) ? '' : undefined}
                  allow="clipboard-write; fullscreen"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
