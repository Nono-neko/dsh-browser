import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdatesStore } from '../src/client/updates.ts'
import { UpdateDetails, mountUpdateDialog } from '../src/client/UpdateDialog.tsx'
import { PanelController } from '../src/client/controller.ts'
import { mountSidebarEntry } from '../src/client/sidebar-entry.ts'
import { setTranslator } from '../src/client/translate.ts'
import { zh, en, type BrowserKey } from '../src/client/locales.ts'
import { updateSnapshot } from './fixtures/updates.ts'
import type { UpdateSnapshot } from '../src/core/updates.ts'
import panelCss from '../src/client/panel/panel.module.css'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const disposers: (() => void)[] = []
afterEach(() => {
  act(() => { disposers.splice(0).reverse().forEach(dispose => dispose()) })
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(getValue: () => UpdateSnapshot = updateSnapshot) {
  setTranslator(key => zh[key as BrowserKey] ?? key)
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, value: getValue() })))
  const store = new UpdatesStore(fetchImpl)
  disposers.push(store.start())
  await store.read()
  return { store, fetchImpl }
}

function render(store: UpdatesStore) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(<UpdateDetails store={store} close={() => {}} />) })
  disposers.push(() => { root.unmount() })
  return host
}

function button(host: HTMLElement, label: string) {
  const result = Array.from(host.querySelectorAll('button')).find(node => node.textContent === label)
  expect(result, label).toBeDefined()
  return result!
}

describe('update UI and lifecycle', () => {
  it('ignores only the current version, survives remounts, and offers later versions again', async () => {
    let value = updateSnapshot()
    const { store } = await setup(() => value)
    const host = render(store)
    expect(store.visibleOffer()?.version).toBe('0.3.0')
    act(() => { button(host, '忽略此版本').click() })
    expect(store.visibleOffer()).toBeUndefined()
    expect(host.textContent).toContain('已忽略提醒')
    const next = await setup(() => value)
    expect(next.store.visibleOffer()).toBeUndefined()
    act(() => { button(host, '恢复提醒').click() })
    expect(store.visibleOffer()?.version).toBe('0.3.0')
    act(() => { store.ignoreCurrent() })
    value = updateSnapshot({ npm: { state: 'ok', release: { version: '0.4.0', url: 'https://www.npmjs.com/package/@nono-neko/dsh-browser/v/0.4.0' } } })
    await act(async () => { await store.read() })
    expect(store.visibleOffer()?.version).toBe('0.4.0')
  })

  it('keeps a source failure distinct from no newer version and explains npm publication lag', async () => {
    const { store } = await setup(() => updateSnapshot({
      npm: { state: 'error' },
      github: { state: 'ok', release: { version: '0.4.0', url: 'https://github.com/Nono-neko/dsh-browser/releases' } },
    }))
    const host = render(store)
    expect(host.querySelector('[role="status"]')?.textContent).toContain('检查暂不可用')
    expect(host.textContent).not.toContain('未发现新版本')
    expect(store.visibleOffer()).toBeUndefined()
    const lag = await setup(() => updateSnapshot({ npm: { state: 'ok', release: { version: '0.2.0', url: '' } } }))
    const lagHost = render(lag.store)
    expect(lagHost.textContent).toContain('npm 尚未同步')
  })

  it('renders release notes only as text and recovers after the local API fails', async () => {
    const value = updateSnapshot()
    value.github.release!.notes = '<img src=x onerror=alert(1)>'
    const { store, fetchImpl } = await setup(() => value)
    const host = render(store)
    expect(host.querySelector('pre')?.textContent).toBe(value.github.release!.notes)
    expect(host.querySelector('img')).toBeNull()
    fetchImpl.mockRejectedValueOnce(new Error('Host restarted'))
    await act(async () => { await store.refresh() })
    expect(store.visibleOffer()).toBeUndefined()
    expect(host.querySelector('[role="status"]')?.textContent).toContain('检查暂不可用')
    await act(async () => { await store.refresh() })
    expect(store.visibleOffer()?.version).toBe('0.3.0')
    expect(fetchImpl.mock.calls.slice(1).every(([url, init]) => url === '/api/dsh-browser/updates/check' && init?.method === 'POST')).toBe(true)
  })

  it('opens details independently of browser navigation and self-heals the sidebar row', async () => {
    const { store } = await setup()
    const pane = document.createElement('div')
    pane.dataset.pane = 'sidebar'
    pane.innerHTML = '<div><button class="newSession">New session</button><section>Workspaces</section></div>'
    document.body.appendChild(pane)
    const controller = new PanelController()
    const open = vi.fn()
    disposers.push(mountSidebarEntry(controller, { store, open }))
    const entry = document.querySelector<HTMLElement>('[data-dsh-browser-entry]')!
    // Navigation must not inherit the workspace file rows' border and padding.
    expect(entry.classList.contains(panelCss.entryRow)).toBe(false)
    const badge = entry.querySelector<HTMLButtonElement>('[data-dsh-browser-updates]')!
    badge.click()
    expect(open).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().panelOpen).toBe(false)
    entry.querySelector<HTMLButtonElement>('button[aria-label="浏览器"]')!.click()
    expect(controller.getSnapshot().panelOpen).toBe(true)
    entry.remove()
    await Promise.resolve()
    expect(document.querySelectorAll('[data-dsh-browser-entry]')).toHaveLength(1)
    store.ignoreCurrent()
    expect(badge.dataset.available).toBe('false')
    expect(entry.querySelector('button button')).toBeNull()
  })

  it('keeps a readable update label when no update is available or an offer is ignored', async () => {
    let value = updateSnapshot({ currentVersion: '0.3.0' })
    const { store } = await setup(() => value)
    const pane = document.createElement('div')
    pane.dataset.pane = 'sidebar'
    pane.innerHTML = '<div><button class="newSession">New session</button></div>'
    document.body.appendChild(pane)
    const controller = new PanelController()
    const open = vi.fn()
    disposers.push(mountSidebarEntry(controller, { store, open }))
    const badge = pane.querySelector<HTMLButtonElement>('[data-dsh-browser-updates]')!
    expect(badge.textContent).toBe('检查更新')
    expect(badge.getAttribute('aria-label')).toContain('检查更新')
    badge.click()
    expect(open).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().panelOpen).toBe(false)
    value = updateSnapshot()
    await store.read()
    expect(badge.textContent).toBe('可更新')
    store.ignoreCurrent()
    expect(badge.textContent).toBe('检查更新')
    expect(badge.dataset.available).toBe('false')
  })

  it('mounts a closable modal without replacing the preview iframe', async () => {
    const { store } = await setup()
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    // jsdom does not implement the native dialog methods.
    const prototype = HTMLDialogElement.prototype
    const originalShow = Object.getOwnPropertyDescriptor(prototype, 'showModal')
    const originalClose = Object.getOwnPropertyDescriptor(prototype, 'close')
    Object.defineProperty(prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
    Object.defineProperty(prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
    disposers.push(() => {
      if (originalShow) Object.defineProperty(prototype, 'showModal', originalShow)
      else delete (prototype as Partial<HTMLDialogElement>).showModal
      if (originalClose) Object.defineProperty(prototype, 'close', originalClose)
      else delete (prototype as Partial<HTMLDialogElement>).close
    })
    let mount!: ReturnType<typeof mountUpdateDialog>
    act(() => { mount = mountUpdateDialog(store) })
    disposers.push(mount.dispose)
    await act(async () => { mount.open(); await store.read() })
    const dialog = document.querySelector<HTMLDialogElement>('dialog')!
    expect(dialog.open).toBe(true)
    act(() => { dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭更新详情"]')!.click() })
    expect(dialog.open).toBe(false)
    expect(document.querySelector('iframe')).toBe(iframe)
  })

  it('polls only the local host cache and cancels timers on teardown', async () => {
    vi.useFakeTimers()
    const { store, fetchImpl } = await setup()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls.every(([url, init]) => url === '/api/dsh-browser/updates' && init?.method === 'GET')).toBe(true)
    disposers.splice(0).forEach(dispose => dispose())
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().unavailable).toBe(false)
  })

  it('keeps English and Chinese update/settings keys in sync', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('drops an old in-flight response when the plugin is disabled and re-enabled', async () => {
    let finishOld!: (value: Response) => void
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, value: updateSnapshot() })))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve }))
    const store = new UpdatesStore(fetchImpl)
    const stop = store.start()
    const pending = store.read()
    stop()
    disposers.push(store.start())
    await store.read()
    const old = updateSnapshot({ npm: { state: 'ok', release: { version: '0.9.0', url: '' } } })
    finishOld(new Response(JSON.stringify({ ok: true, value: old })))
    await pending
    expect(store.visibleOffer()?.version).toBe('0.3.0')
    expect(store.getSnapshot().busy).toBe(false)
  })
})
