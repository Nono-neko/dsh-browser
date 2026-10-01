// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Volatile } from '@deepseek-ai/cordis'
import SettingsForms from '@deepseek-ai/dsh-settings'
import * as browser from '../src/index.ts'
import type { BrowserConfig } from '../src/core/types.ts'

const calls = vi.hoisted(() => ({
  routes: vi.fn(),
  routeDisposers: [] as ReturnType<typeof vi.fn>[],
  updateConfigure: vi.fn(),
  updateDispose: vi.fn(),
  broadcasterDispose: vi.fn(),
}))

vi.mock('../src/host/gate.ts', () => ({ createWorkspaceGate: () => vi.fn() }))
vi.mock('../src/host/routes.ts', () => ({
  OpenBroadcaster: class {
    push = vi.fn()
    dispose = calls.broadcasterDispose
  },
  registerBrowserRoutes: calls.routes,
  normalizeProxyServer: (value: string) => value || undefined,
}))
vi.mock('../src/host/update-service.ts', () => ({
  detectInstallation: () => 'source',
  UpdateService: class {
    configure = calls.updateConfigure
    dispose = calls.updateDispose
  },
}))

const defaults: Required<BrowserConfig> = {
  enabled: true,
  announceToAgent: true,
  autoCheckUpdates: true,
  followRepositoryUpdates: false,
  defaultHome: 'https://www.bing.com',
  maxTabs: 10,
  allowPrivateAccess: false,
  browserExecutable: '',
  proxyServer: '',
}

const roots: Context[] = []

function context() {
  const ctx = new Context()
  roots.push(ctx)
  const section = vi.fn(() => vi.fn())
  const register = vi.fn(() => vi.fn())
  ctx.provide('webServer', {})
  ctx.provide('workspaceRegistry', {})
  ctx.provide('systemPrompt', { section })
  ctx.provide('tools', { register })
  return { ctx, section, register }
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.routeDisposers.splice(0)
  calls.routes.mockImplementation(() => {
    const dispose = vi.fn()
    calls.routeDisposers.push(dispose)
    return dispose
  })
})

afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
})

describe('alpha3 host configuration', () => {
  it('exposes all browser fields through the real SettingsForms projection and claims its custom page', async () => {
    const { ctx } = context()
    const home = join(tmpdir(), `dsh-browser-settings-absent-${randomUUID()}`)
    const configuration = vi.fn(() => [] as unknown[])
    ctx.provide('profileContext', { home, name: 'test' })
    ctx.provide('configEditor', { configuration, documentPath: join(home, 'cordis.patch.yml') })
    ctx.provide('loader', { await: async () => {} })
    await ctx.plugin(SettingsForms)
    const fiber = await ctx.plugin(browser, {})
    configuration.mockReturnValue([{
      entry: { id: 'dsh-browser', options: { id: 'dsh-browser', config: {} }, fiber },
      inherited: {},
      override: {},
    }])

    const descriptor = ctx.settings.describe().find(row => row.ns === 'dsh-browser')

    expect(descriptor).toMatchObject({
      ns: 'dsh-browser',
      autoGenerate: false,
      applies: 'live',
      value: defaults,
      base: defaults,
      user: {},
    })
    const schema = descriptor!.schema as { uid: number; refs: Record<number, { dict: object }> }
    expect(Object.keys(schema.refs[schema.uid].dict).sort()).toEqual(Object.keys(defaults).sort())
  })

  it('applies committed live values to tools and routes without restarting its runtime', async () => {
    const { ctx, section, register } = context()
    const values = { ...defaults }
    const references = Object.fromEntries(Object.keys(values).map(key => [key, {
      get: () => Reflect.get(values, key),
    }])) as { [Field in keyof Required<BrowserConfig>]: Volatile<Required<BrowserConfig>[Field]> }
    const apply = vi.fn((owner: Context) => browser.apply(owner, references))
    const fiber = await ctx.plugin({ name: browser.name, inject: browser.inject, apply })

    expect(register).toHaveBeenCalledTimes(4)
    expect(section).toHaveBeenCalledTimes(1)
    expect(calls.routes.mock.calls.at(-1)?.[3]).toMatchObject({ allowPrivate: false })

    values.allowPrivateAccess = true
    values.proxyServer = 'http://127.0.0.1:7890'
    values.browserExecutable = 'C:/browser/chrome.exe'
    values.announceToAgent = false
    fiber.ctx.emit('loader/volatile-update', [['allowPrivateAccess'], ['proxyServer'], ['browserExecutable'], ['announceToAgent']])

    expect(apply).toHaveBeenCalledTimes(1)
    expect(calls.routes.mock.calls.at(-1)?.[3]).toEqual({
      allowPrivate: true,
      proxyServer: values.proxyServer,
      executablePath: values.browserExecutable,
    })
    expect(section.mock.results[0]?.value).toHaveBeenCalledTimes(1)
    expect(section).toHaveBeenCalledTimes(1)
    for (const registered of register.mock.results.slice(0, 4)) expect(registered.value).toHaveBeenCalledTimes(1)

    values.enabled = false
    fiber.ctx.emit('loader/volatile-update', [['enabled']])
    expect(calls.routeDisposers[1]).toHaveBeenCalledTimes(1)
    expect(calls.updateConfigure).toHaveBeenLastCalledWith(false, true, false)
    expect(calls.routes).toHaveBeenCalledTimes(2)
    for (const registered of register.mock.results.slice(4, 8)) expect(registered.value).toHaveBeenCalledTimes(1)

    values.enabled = true
    values.autoCheckUpdates = false
    values.followRepositoryUpdates = true
    fiber.ctx.emit('loader/volatile-update', [['enabled'], ['autoCheckUpdates'], ['followRepositoryUpdates']])
    expect(calls.routes).toHaveBeenCalledTimes(3)
    expect(calls.updateConfigure).toHaveBeenLastCalledWith(true, false, true)
    expect(register).toHaveBeenCalledTimes(12)
    expect(apply).toHaveBeenCalledTimes(1)

    await fiber.dispose()
    expect(calls.routeDisposers[2]).toHaveBeenCalledTimes(1)
    expect(calls.updateDispose).toHaveBeenCalledTimes(1)
    expect(calls.broadcasterDispose).toHaveBeenCalledTimes(1)
    const syncCount = calls.updateConfigure.mock.calls.length
    ctx.emit('loader/volatile-update', [['enabled']])
    expect(calls.updateConfigure).toHaveBeenCalledTimes(syncCount)
  })
})
