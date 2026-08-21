/**
 * Staged form model for the plugin settings card.
 *
 * A card stages what the user types and writes it only when they save. Each
 * settings write is a durable, revision-fenced document mutation, so a control
 * that committed as it settled would turn one edit into a write the user
 * never asked for. The semantics mirror the official dsh settings cards
 * (staged drafts, inherit/reset, save reads back what the Host accepted) but
 * the implementation is self-contained: a standalone plugin cannot value-import
 * the shell's card form package.
 * @module dsh-browser/client/settings/card-form
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'

export type CardFieldKind = 'boolean' | 'text' | 'number'

export interface CardFieldDef {
  field: string
  kind: CardFieldKind
}

export interface CardFieldState {
  /** Draft text the control renders. */
  text: string
  /** Whether a save would leave (or keep) a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  invalid: boolean
}

export interface CardState {
  /** Namespace serving status: loading until the first Host view. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
  fields: Record<string, CardFieldState>
}

type Staged = { kind: 'set'; value: unknown } | { kind: 'clear' } | { kind: 'invalid' }

/**
 * One staged form over one settings namespace.
 */
export class BrowserSettingsForm<T extends object> {
  readonly store: HostObservable<CardState>
  private staged = new Map<string, Staged>()
  private invalidText = new Map<string, string>()
  private saving = false
  private failed = false
  private listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private cached: CardState

  constructor(
    private readonly scope: SettingsScope<T>,
    private readonly defs: CardFieldDef[],
  ) {
    this.cached = this.build()
    this.store = {
      getSnapshot: () => this.cached,
      subscribe: (fn: () => void) => {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
    }
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /** The registration-side face: the observable plus the form actions. */
  injectFace(): { hooks: { browserSettingsCard: HostObservable<CardState> } } & BrowserSettingsActions {
    return {
      hooks: { browserSettingsCard: this.store },
      editText: (field: string, text: string) => { this.editText(field, text) },
      setBoolean: (field: string, value: boolean) => { this.setBoolean(field, value) },
      resetField: (field: string) => { this.resetField(field) },
      save: () => { void this.save() },
      discard: () => { this.discard() },
      refresh: () => { void (this.scope as unknown as { load: () => Promise<void> }).load() },
    }
  }

  editText(field: string, text: string): void {
    const def = this.defs.find(entry => entry.field === field)
    if (def === undefined || def.kind === 'boolean') return
    this.invalidText.delete(field)
    if (text === '') {
      this.staged.set(field, { kind: 'clear' })
    } else if (def.kind === 'number') {
      const value = Number(text)
      if (Number.isInteger(value) && Number.isFinite(value)) {
        this.staged.set(field, { kind: 'set', value })
      } else {
        this.staged.set(field, { kind: 'invalid' })
        this.invalidText.set(field, text)
      }
    } else {
      this.staged.set(field, { kind: 'set', value: text })
    }
    this.failed = false
    this.publish()
  }

  setBoolean(field: string, value: boolean): void {
    const def = this.defs.find(entry => entry.field === field)
    if (def === undefined || def.kind !== 'boolean') return
    this.staged.set(field, { kind: 'set', value })
    this.failed = false
    this.publish()
  }

  resetField(field: string): void {
    if (!this.defs.some(entry => entry.field === field)) return
    this.staged.set(field, { kind: 'clear' })
    this.failed = false
    this.publish()
  }

  /** Write every staged edit, then re-seed from what the Host accepted. */
  async save(): Promise<void> {
    if (this.saving || this.cached.invalid || this.cached.status !== 'ready' || !this.cached.writable) return
    this.saving = true
    this.publish()
    const submitted = new Map(this.staged)
    const writes: Array<Promise<void>> = []
    for (const [field, staged] of submitted) {
      if (staged.kind === 'set') writes.push(this.scope.set(field, staged.value))
      else if (staged.kind === 'clear') writes.push(this.scope.unset(field))
    }
    try {
      await Promise.all(writes)
      // SettingsScope settles after its authoritative read-back even when the
      // Host rejects a mutation. Reconcile every submitted field against the
      // accepted user layer instead of treating Promise resolution as success.
      const snap = this.scope.getSnapshot()
      const user = (snap.user !== null && typeof snap.user === 'object' && !Array.isArray(snap.user)
        ? snap.user
        : {}) as Record<string, unknown>
      let rejected = false
      for (const [field, staged] of submitted) {
        const landed = staged.kind === 'clear'
          ? !(field in user)
          : staged.kind === 'set' && field in user && Object.is(user[field], staged.value)
        if (!landed) rejected = true
        // Preserve edits made while this save was crossing the wire.
        if (landed && this.staged.get(field) === staged) {
          this.staged.delete(field)
          this.invalidText.delete(field)
        }
      }
      this.saving = false
      this.failed = rejected
    } catch {
      // A save that did not land keeps its drafts so the user can correct them.
      this.saving = false
      this.failed = true
    }
    this.publish()
  }

  discard(): void {
    this.staged.clear()
    this.failed = false
    this.publish()
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  private snapshot(): { status: 'loading' | 'ready' | 'unavailable'; value: T | undefined; user: unknown; writable: boolean } {
    const snap = this.scope.getSnapshot()
    return { status: snap.status, value: snap.value, user: snap.user, writable: snap.writable }
  }

  private build(): CardState {
    const { status, value, user, writable } = this.snapshot()
    const userLayer = (user !== null && typeof user === 'object' ? user : {}) as Record<string, unknown>
    const section = value ?? {} as T
    const fields: Record<string, CardFieldState> = {}
    let invalid = false
    for (const def of this.defs) {
      const staged = this.staged.get(def.field)
      const raw = (section as Record<string, unknown>)[def.field]
      let text: string
      if (staged === undefined) {
        text = formatValue(def.kind, raw)
      } else if (staged.kind === 'clear') {
        text = ''
      } else if (staged.kind === 'invalid') {
        text = this.invalidText.get(def.field) ?? ''
        invalid = true
      } else {
        text = formatValue(def.kind, staged.value)
      }
      const overridden = staged !== undefined
        ? staged.kind !== 'clear'
        : def.field in userLayer
      const fieldInvalid = staged !== undefined && staged.kind === 'invalid'
      if (fieldInvalid) invalid = true
      fields[def.field] = { text, overridden, invalid: fieldInvalid }
    }
    return {
      status,
      writable,
      dirty: this.staged.size > 0,
      invalid,
      saving: this.saving,
      failed: this.failed,
      fields,
    }
  }

  private publish(): void {
    this.cached = this.build()
    for (const fn of [...this.listeners]) fn()
  }
}

export interface BrowserSettingsActions {
  editText: (field: string, text: string) => void
  setBoolean: (field: string, value: boolean) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
  refresh: () => void
}

function formatValue(kind: CardFieldKind, value: unknown): string {
  if (value === undefined || value === null) return ''
  if (kind === 'boolean') return value === true ? 'true' : value === false ? 'false' : ''
  if (kind === 'number') return typeof value === 'number' ? String(value) : ''
  return typeof value === 'string' ? value : ''
}
