import { describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { BrowserSettingsForm } from '../src/client/settings/card-form.ts'

interface TestSettings {
  defaultHome?: string
  maxTabs?: number
}

function scopeHarness(initial: { value: TestSettings; user: Record<string, unknown> }): {
  scope: SettingsScope<TestSettings>
  publish: (next: { value: TestSettings; user: Record<string, unknown> }) => void
  setWrite: (write: (field: string, value: unknown) => Promise<void>) => void
} {
  let snapshot: SettingsScopeSnapshot<TestSettings> = {
    status: 'ready',
    value: initial.value,
    base: {},
    user: initial.user,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  let write: (field: string, value: unknown) => Promise<void> = async () => {}
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: (field, value) => write(field, value),
      unset: async () => {},
    },
    publish: (next) => {
      snapshot = { ...snapshot, ...next, revision: (snapshot.revision ?? 0) + 1 }
      for (const listener of [...listeners]) listener()
    },
    setWrite: (next) => { write = next },
  }
}

describe('BrowserSettingsForm', () => {
  it('clears a draft after the accepted user layer contains it', async () => {
    const harness = scopeHarness({ value: { maxTabs: 10 }, user: {} })
    harness.setWrite(async (field, value) => {
      harness.publish({ value: { maxTabs: value as number }, user: { [field]: value } })
    })
    const form = new BrowserSettingsForm(harness.scope, [{ field: 'maxTabs', kind: 'number' }])
    form.editText('maxTabs', '20')

    await form.save()

    const state = form.store.getSnapshot()
    expect(state.fields.maxTabs.text).toBe('20')
    expect(state.dirty).toBe(false)
    expect(state.failed).toBe(false)
    form.dispose()
  })

  it('keeps a draft when a resolved settings write did not land', async () => {
    const harness = scopeHarness({ value: { maxTabs: 10 }, user: {} })
    const form = new BrowserSettingsForm(harness.scope, [{ field: 'maxTabs', kind: 'number' }])
    form.editText('maxTabs', '31')

    await form.save()

    const state = form.store.getSnapshot()
    expect(state.fields.maxTabs.text).toBe('31')
    expect(state.dirty).toBe(true)
    expect(state.failed).toBe(true)
    form.dispose()
  })

  it('preserves edits made while an earlier save is in flight', async () => {
    const harness = scopeHarness({
      value: { defaultHome: 'https://old.example/', maxTabs: 10 },
      user: {},
    })
    let release: (() => void) | undefined
    harness.setWrite((field, value) => new Promise<void>((resolve) => {
      release = () => {
        harness.publish({
          value: { defaultHome: 'https://old.example/', maxTabs: value as number },
          user: { [field]: value },
        })
        resolve()
      }
    }))
    const form = new BrowserSettingsForm(harness.scope, [
      { field: 'maxTabs', kind: 'number' },
      { field: 'defaultHome', kind: 'text' },
    ])
    form.editText('maxTabs', '20')
    const saving = form.save()
    form.editText('defaultHome', 'https://new.example/')
    release?.()
    await saving

    const state = form.store.getSnapshot()
    expect(state.fields.defaultHome.text).toBe('https://new.example/')
    expect(state.fields.defaultHome.overridden).toBe(true)
    expect(state.dirty).toBe(true)
    expect(state.failed).toBe(false)
    form.dispose()
  })
})
