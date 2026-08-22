/**
 * dsh-browser — browser half. Registers the locale dictionaries, mounts the
 * sidebar entry (plain DOM, self-healing) and the center-column browser panel
 * (React), subscribes to host open events (agent browser_open pushes), follows
 * the active session's workspace (tabs persist per root), and contributes the
 * plugin settings card to the official Plugins section.
 *
 * Failure policy: every DOM/runtime wiring failure is logged, never thrown —
 * the web shell fails the whole boot when a plugin apply throws.
 * @module dsh-browser/client
 */

import type {
  ClientContext,
  ISessions,
  SessionId,
  SettingsScope,
  SettingsScopeSpec,
} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// NOTE: the ui-settings and connection client type modules are deliberately
// NOT imported: their declaration chains pull the HOST-side dsh-session
// Context merge into the program, which conflicts with the runtime's
// ctx.sessions (ISessions) typing. The settingsScope service face is declared
// locally below instead.
import { subscribeOpenEvents } from './api.ts'
import { PanelController } from './controller.ts'
import { en, zh, type BrowserKey } from './locales.ts'
import { mountPanel } from './mount.tsx'
import { bindTabPersistPagehide, createTabPersist, readPersisted } from './persist.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { initialState, makeTab, TabsStore } from './store.ts'
import { setTranslator } from './translate.ts'
import { BrowserSettingsForm } from './settings/card-form.ts'
import { BrowserSettingsCard, BrowserSettingsPage, setDesktopForm, clearDesktopForm } from './settings/BrowserSettingsCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser surface copy. */
    'dsh-browser': BrowserKey
  }
}

/** The settings-scope service face (provided by dsh-client-ui-settings). */
interface SettingsScopeBinder {
  bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    settingsScope: SettingsScopeBinder
  }
}

/** Locale namespace this plugin owns. */
const NS = 'dsh-browser'

/** Settings namespace the card edits (the Host plugin registers it). */
const SETTINGS_NS = 'dsh-browser'

/** The browser settings the surfaces read (live, schema-defaulted). */
interface BrowserSettings {
  enabled?: boolean
  announceToAgent?: boolean
  defaultHome?: string
  maxTabs?: number
  allowPrivateAccess?: boolean
}

/** Services required by the browser half. */
export const inject = ['sessions', 'slots', 'locale', 'connection', 'settingsScope', 'remote']

/** Resolve the live settings read with schema defaults. */
function resolveSettings(scope: SettingsScope<BrowserSettings>): {
  enabled: boolean
  defaultHome: string
  maxTabs: number
} {
  const snapshot = scope.getSnapshot()
  const value = snapshot.value ?? {}
  return {
    enabled: value.enabled ?? true,
    defaultHome: typeof value.defaultHome === 'string' && value.defaultHome !== ''
      ? value.defaultHome
      : 'https://www.bing.com',
    maxTabs: typeof value.maxTabs === 'number' ? Math.max(2, value.maxTabs) : 10,
  }
}

/**
 * Apply the browser half.
 * @param ctx - client root context (sessions, slots, locale, settings).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-browser: dictionaries')
  const t = ctx.locale.bind(NS)
  const wideT: (key: string) => string = key => t(key as never)
  setTranslator(wideT)

  const sessions = ctx.sessions as unknown as ISessions
  const settingsScope = ctx.settingsScope.bind<BrowserSettings>({ namespace: SETTINGS_NS })
  const settings = (): { enabled: boolean; defaultHome: string; maxTabs: number } => resolveSettings(settingsScope)

  // The tabs store survives the enabled toggle; only the DOM surfaces and the
  // event subscription ride the syncUi effect.
  const controller = new PanelController()
  const store = new TabsStore(() => settings().maxTabs)
  const persist = createTabPersist()
  const disposePagehide = bindTabPersistPagehide(persist)
  const disposePersist = store.subscribe(() => {
    if (store.getSnapshot().root !== '') persist.save(store.getSnapshot())
  })

  // The project root follows the active session's cwd; switching sessions
  // re-binds the store (tabs persist per root in localStorage).
  const rebindRoot = (): void => {
    const snapshot = sessions.list.getSnapshot()
    const sessionId = snapshot.current as SessionId | undefined
    const cwd = sessionId === undefined ? undefined : snapshot.byId[sessionId]?.cwd
    const root = typeof cwd === 'string' && cwd !== '' ? cwd : ''
    if (store.getSnapshot().root === root) return
    // Commit every root's pending snapshot before a target root is read back;
    // otherwise a rapid A -> B -> A switch could restore stale A and replace
    // the newer in-memory pending value for that same key.
    persist.flush()
    const persisted = readPersisted(root)
    if (persisted !== undefined && persisted.tabs.length > 0) {
      store.set({
        root,
        tabs: persisted.tabs.map(entry => {
          const tab = makeTab(entry.url)
          tab.id = entry.id
          tab.label = entry.label
          tab.stack = entry.stack
          tab.index = entry.index
          return tab
        }),
        activeId: persisted.activeId,
      })
    } else {
      store.set(initialState(root))
    }
  }
  rebindRoot()
  const disposeSessions = sessions.list.subscribe(rebindRoot)

  let disposeUi: (() => void) | undefined
  const syncUi = (): void => {
    store.enforceLimit()
    if (settings().enabled && disposeUi === undefined) {
      disposeUi = ctx.effect(() => {
        const disposers: Array<() => void> = []
        disposers.push(subscribeOpenEvents((url) => {
          store.openTab(url)
          controller.open()
        }))
        try {
          disposers.push(mountSidebarEntry(controller))
          disposers.push(mountPanel(controller, store, {
            defaultHome: () => settings().defaultHome,
            maxTabs: () => settings().maxTabs,
            t: wideT,
          }))
        } catch (error) {
          // DOM failures degrade the panel, never the GUI.
          console.warn('[dsh-browser] mount failed:', error)
        }
        return () => {
          for (const dispose of disposers.splice(0)) dispose()
        }
      }, 'dsh-browser: ui mounts')
    } else if (!settings().enabled && disposeUi !== undefined) {
      disposeUi()
      disposeUi = undefined
    }
  }
  settingsScope.subscribe(syncUi)
  syncUi()

  // Plugin configuration UI.
  //
  // RUNTIME SPLIT:
  //   - web build:      register into settings.plugin.item (a card inside the
  //                     Plugins section's "插件配置" tab). This is a list slot
  //                     using plain callback + id.
  //   - Desktop build:  register into settings.section (a standalone entry in
  //                     the settings left nav). This avoids the Desktop build's
  //                     keyed-slot incompatibility and matches how built-in
  //                     Desktop features (桌面版, Web UI 插件) expose settings.
  const isDesktop = typeof navigator !== 'undefined' && /Electron/.test(navigator.userAgent)
  const formFields = [
    { field: 'enabled', kind: 'boolean' as const },
    { field: 'announceToAgent', kind: 'boolean' as const },
    { field: 'allowPrivateAccess', kind: 'boolean' as const },
    { field: 'defaultHome', kind: 'text' as const },
    { field: 'maxTabs', kind: 'number' as const },
    { field: 'browserExecutable', kind: 'text' as const },
    { field: 'proxyServer', kind: 'text' as const },
  ]

  if (isDesktop) {
    // Desktop: standalone settings page in the left nav.
    // settings.section does not support the `inject` option, so we stash the
    // form face in a module-level variable that BrowserSettingsPage reads.
    ctx.slots.inject('settings.section' as any, () => {
      const form = new BrowserSettingsForm<BrowserSettings>(settingsScope, formFields)
      setDesktopForm(form)
      const disposeRegister = ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-browser',
        order: 90,
        label: () => t('settings.title'),
        locale: NS,
      } as any, BrowserSettingsPage)
      return () => {
        disposeRegister()
        form.dispose()
        clearDesktopForm()
      }
    })
  } else {
    // Web: card inside the Plugins section
    ctx.slots.inject('settings.plugin.item', () => {
      const form = new BrowserSettingsForm<BrowserSettings>(settingsScope, formFields)
      const disposeForm = (): void => { form.dispose() }
      return [disposeForm, ctx.slots.register({
        name: 'settings.plugin.item',
        id: 'dsh-browser',
        order: 90,
        locale: NS,
        inject: () => form.injectFace(),
      }, BrowserSettingsCard)]
    })
  }

  ctx.effect(() => () => {
    disposeUi?.()
    disposeUi = undefined
    disposeSessions()
    disposePersist()
    disposePagehide()
    persist.flush()
    persist.dispose()
  }, 'dsh-browser: wiring')
}
