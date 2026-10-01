import { describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { BrowserSettingsForm } from '../src/client/settings/card-form.ts'

interface TestSettings {
  defaultHome?: string
  maxTabs?: number
}

function scopeHarness(initial: { value: TestSettings; user: Record<string, unknown> }): {
  scope: ConfigForm<TestSettings>
  publish: (next: { value: TestSettings; user: Record<string, unknown> }) => void
  setMutation: (mutation: ConfigForm<TestSettings>['mutate']) => void
} {
  let snapshot: ConfigFormSnapshot<TestSettings> = {
    status: 'ready',
    value: initial.value,
    base: {},
    user: initial.user,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  let mutate: ConfigForm<TestSettings>['mutate'] = async () => false
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: (field, value) => mutate([{ op: 'set', path: [field], value: value as number | string }]),
      unset: (field) => mutate([{ op: 'unset', path: [field] }]),
      mutate: (ops, revision) => mutate(ops, revision),
    },
    publish: (next) => {
      snapshot = { ...snapshot, ...next, revision: (snapshot.revision ?? 0) + 1 }
      for (const listener of [...listeners]) listener()
    },
    setMutation: (next) => { mutate = next },
  }
}

describe('BrowserSettingsForm', () => {
  it('clears a draft after the accepted user layer contains it', async () => {
    const harness = scopeHarness({ value: { maxTabs: 10 }, user: {} })
    harness.setMutation(async (ops) => {
      const op = ops[0]
      if (op.op !== 'set') throw new Error('Expected a set operation')
      harness.publish({ value: { maxTabs: op.value as number }, user: { [op.path[0]]: op.value } })
      return true
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
    harness.setMutation((ops) => new Promise<boolean>((resolve) => {
      const op = ops[0]
      if (op.op !== 'set') throw new Error('Expected a set operation')
      release = () => {
        harness.publish({
          value: { defaultHome: 'https://old.example/', maxTabs: op.value as number },
          user: { [op.path[0]]: op.value },
        })
        resolve(true)
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

  it('submits sets and resets together with one revision fence', async () => {
    const harness = scopeHarness({
      value: { defaultHome: 'https://old.example/', maxTabs: 20 },
      user: { maxTabs: 20 },
    })
    const mutation = vi.fn(async () => {
      harness.publish({
        value: { defaultHome: 'https://new.example/', maxTabs: 10 },
        user: { defaultHome: 'https://new.example/' },
      })
      return true
    })
    harness.setMutation(mutation)
    const form = new BrowserSettingsForm(harness.scope, [
      { field: 'defaultHome', kind: 'text' },
      { field: 'maxTabs', kind: 'number' },
    ])
    form.editText('defaultHome', 'https://new.example/')
    form.resetField('maxTabs')

    await form.save()

    expect(mutation).toHaveBeenCalledExactlyOnceWith([
      { op: 'set', path: ['defaultHome'], value: 'https://new.example/' },
      { op: 'unset', path: ['maxTabs'] },
    ], 1)
    expect(form.store.getSnapshot()).toMatchObject({ dirty: false, failed: false })
    expect(form.store.getSnapshot().fields.maxTabs).toMatchObject({ text: '10', overridden: false })
    form.dispose()
  })

  it('preserves every draft when a multi-field save is refused', async () => {
    const harness = scopeHarness({ value: { maxTabs: 10, defaultHome: 'https://old.example/' }, user: {} })
    const form = new BrowserSettingsForm(harness.scope, [
      { field: 'maxTabs', kind: 'number' },
      { field: 'defaultHome', kind: 'text' },
    ])
    form.editText('maxTabs', '31')
    form.editText('defaultHome', 'https://new.example/')

    await form.save()

    expect(form.store.getSnapshot()).toMatchObject({ dirty: true, failed: true, saving: false })
    expect(form.store.getSnapshot().fields.maxTabs.text).toBe('31')
    expect(form.store.getSnapshot().fields.defaultHome.text).toBe('https://new.example/')
    expect(harness.scope.getSnapshot().user).toEqual({})
    form.dispose()
  })
})
