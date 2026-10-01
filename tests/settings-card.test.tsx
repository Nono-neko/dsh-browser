import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import {
  BrowserSettingsCard,
  BrowserSettingsPage,
  setDesktopForm,
  clearDesktopForm,
  type BrowserSettingsCardProps,
} from '../src/client/settings/BrowserSettingsCard.tsx'
import { BrowserSettingsForm, type CardState } from '../src/client/settings/card-form.ts'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { zh } from '../src/client/locales.ts'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

describe('BrowserSettingsCard', () => {
  it('shows an inherited resolved boolean as Inherit', () => {
    const state: CardState = {
      status: 'ready',
      writable: true,
      dirty: false,
      invalid: false,
      saving: false,
      failed: false,
      fields: {
        enabled: { text: 'true', overridden: false, invalid: false },
        announceToAgent: { text: 'true', overridden: false, invalid: false },
        autoCheckUpdates: { text: 'true', overridden: false, invalid: false },
        followRepositoryUpdates: { text: 'false', overridden: false, invalid: false },
        allowPrivateAccess: { text: 'false', overridden: false, invalid: false },
        defaultHome: { text: 'https://www.bing.com', overridden: false, invalid: false },
        maxTabs: { text: '10', overridden: false, invalid: false },
        browserExecutable: { text: '', overridden: false, invalid: false },
        proxyServer: { text: '', overridden: false, invalid: false },
      },
    }
    const props = {
      t: (key: string) => key,
      useBrowserSettingsCard: <T,>(selector: (value: CardState) => T) => selector(state),
      editText: () => {},
      setBoolean: () => {},
      resetField: () => {},
      save: () => {},
      discard: () => {},
      refresh: () => {},
    } as unknown as BrowserSettingsCardProps
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => { root.render(createElement(BrowserSettingsCard, props)) })

    // Card is collapsed by default; click the header to disclose the form.
    const header = host.querySelector('button[aria-expanded="false"]')
    expect(header).not.toBeNull()
    act(() => { (header as HTMLButtonElement).click() })

    const inherit = Array.from(host.querySelectorAll('button'))
      .find(button => button.textContent === 'settings.inherit')
    expect(inherit?.dataset.active).toBe('true')

    act(() => { root.unmount() })
    host.remove()
  })

  it('shows the page controls when the Host exposes the configuration namespace', () => {
    const values = {
      enabled: true,
      announceToAgent: true,
      autoCheckUpdates: true,
      followRepositoryUpdates: false,
      allowPrivateAccess: false,
      defaultHome: 'https://www.bing.com',
      maxTabs: 10,
      browserExecutable: '',
      proxyServer: '',
    }
    let snapshot: ConfigFormSnapshot<typeof values> = {
      status: 'unavailable', value: undefined, base: undefined, user: undefined,
      revision: undefined, writable: false, mode: 'host',
    }
    const listeners = new Set<() => void>()
    const scope: ConfigForm<typeof values> = {
      getSnapshot: () => snapshot,
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: async () => false,
      unset: async () => false,
      mutate: async () => false,
    }
    const form = new BrowserSettingsForm(scope, Object.entries(values).map(([field, value]) => ({
      field,
      kind: typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'text',
    })))
    setDesktopForm(form)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      act(() => {
        root.render(createElement(BrowserSettingsPage, { t: (key: keyof typeof zh) => zh[key] }))
      })
      expect(host.textContent).toContain(zh['settings.notExposed'])

      act(() => {
        snapshot = {
          ...snapshot, status: 'ready', value: values, base: values, user: {}, revision: 0, writable: true,
        }
        for (const listener of listeners) listener()
      })

      expect(host.textContent).not.toContain(zh['settings.notExposed'])
      expect(host.querySelectorAll('input')).toHaveLength(4)
      expect(host.querySelectorAll('[role="group"]')).toHaveLength(5)
      expect(Array.from(host.querySelectorAll('input')).map(input => input.value))
        .toEqual(['https://www.bing.com', '10', '', ''])
    } finally {
      act(() => { root.unmount() })
      host.remove()
      form.dispose()
      clearDesktopForm()
    }
  })
})
