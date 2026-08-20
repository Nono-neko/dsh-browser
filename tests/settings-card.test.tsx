import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import {
  BrowserSettingsCard,
  type BrowserSettingsCardProps,
} from '../src/client/settings/BrowserSettingsCard.tsx'
import type { CardState } from '../src/client/settings/card-form.ts'

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
    } as unknown as BrowserSettingsCardProps
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => { root.render(createElement(BrowserSettingsCard, props)) })

    const inherit = Array.from(host.querySelectorAll('button'))
      .find(button => button.textContent === 'settings.inherit')
    expect(inherit?.dataset.active).toBe('true')

    act(() => { root.unmount() })
    host.remove()
  })
})
