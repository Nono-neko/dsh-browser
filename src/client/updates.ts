/** A plugin-wide view of host-cached checks; this store never contacts registries. */
import { availableUpdate, type UpdateSnapshot } from '../core/updates.ts'
import { fetchUpdates } from './api.ts'

const IGNORE_KEY = 'dsh-browser:ignored-update'

export interface UpdateClientState {
  snapshot?: UpdateSnapshot
  busy: boolean
  unavailable: boolean
  ignoredKey: string | null
}

export class UpdatesStore {
  private state: UpdateClientState = { busy: false, unavailable: false, ignoredKey: null }
  private readonly listeners = new Set<() => void>()
  private active = false
  private running?: Promise<void>
  private manual = false
  private controller?: AbortController
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  getSnapshot = (): UpdateClientState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  visibleOffer = () => {
    const offer = !this.state.unavailable && this.state.snapshot ? availableUpdate(this.state.snapshot) : undefined
    return offer?.key === this.state.ignoredKey ? undefined : offer
  }

  private set(value: Partial<UpdateClientState>): void {
    this.state = { ...this.state, ...value }
    for (const listener of this.listeners) listener()
  }

  private readIgnore = (): void => {
    try { this.set({ ignoredKey: localStorage.getItem(IGNORE_KEY) }) } catch { /* Private mode: keep the in-memory choice. */ }
  }

  ignoreCurrent = (): void => {
    const offer = this.state.snapshot && availableUpdate(this.state.snapshot)
    if (!offer) return
    this.set({ ignoredKey: offer.key })
    try { localStorage.setItem(IGNORE_KEY, offer.key) } catch { /* In-memory fallback. */ }
  }

  restoreIgnored = (): void => {
    this.set({ ignoredKey: null })
    try { localStorage.removeItem(IGNORE_KEY) } catch { /* In-memory fallback. */ }
  }

  private onVisible = (): void => {
    if (document.visibilityState === 'visible') void this.load()
  }

  start(): () => void {
    this.active = true
    this.readIgnore()
    window.addEventListener('storage', this.readIgnore)
    document.addEventListener('visibilitychange', this.onVisible)
    void this.load()
    return () => {
      this.active = false
      this.controller?.abort()
      this.controller = undefined
      this.running = undefined
      if (this.timer) clearTimeout(this.timer)
      window.removeEventListener('storage', this.readIgnore)
      document.removeEventListener('visibilitychange', this.onVisible)
    }
  }

  refresh = (): Promise<void> => this.load(true)
  read = (): Promise<void> => this.load()

  private load(manual = false): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (this.running) {
      return manual && !this.manual ? this.running.then(() => this.load(true)) : this.running
    }
    if (this.timer) clearTimeout(this.timer)
    const controller = new AbortController()
    this.controller = controller
    this.manual = manual
    this.set({ busy: true })
    const timeout = setTimeout(() => { controller.abort() }, 40_000)
    this.running = (async () => {
      try {
        const snapshot = await fetchUpdates(manual, controller.signal, this.fetchImpl)
        if (this.active && this.controller === controller && !controller.signal.aborted) this.set({ snapshot, unavailable: false })
      } catch {
        if (this.active && this.controller === controller) this.set({ unavailable: true })
      } finally {
        clearTimeout(timeout)
        if (this.controller === controller) {
          this.running = undefined
          this.controller = undefined
          this.set({ busy: false })
          if (this.active) {
            const delay = this.state.snapshot?.checking && !this.state.unavailable ? 1_000 : 60_000
            this.timer = setTimeout(() => { void this.load() }, delay)
          }
        }
      }
    })()
    return this.running
  }
}
