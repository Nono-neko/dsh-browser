/**
 * dsh-browser — host half. Mounts the /api/dsh-browser route family (SSE
 * open-event stream + workspace listing/file serving), the agent tools
 * (browser_open, browser_read), the plugin settings namespace, and a
 * system-prompt announcement. The browser half (./client) renders the sidebar
 * entry, the multi-tab panel, and the settings card. Everything rides the
 * official NPM SDK packages — no dsh source changes.
 * @module @linxin666/dsh-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { createWorkspaceGate } from './host/gate.ts'
import { OpenBroadcaster, registerBrowserRoutes } from './host/routes.ts'
import { browserOpenTool, browserReadTool, readPage } from './host/tools.ts'
import type { BrowserConfig } from './core/types.ts'

/** Stable cordis plugin name. */
export const name = 'dsh-browser'

/** Services required before the browser surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt', 'workspaceRegistry']

/** Settings namespace of the browser capability — the section the web settings surface edits. */
export const BROWSER_SETTINGS_NAMESPACE = settingsNamespace('dsh-browser')

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config extends BrowserConfig {}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  defaultHome: z.string().default('https://www.bing.com'),
  maxTabs: z.number().step(1).min(2).max(30).default(10),
  allowPrivateAccess: z.boolean().default(false),
})

/** Schema defaults, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULTS = {
  enabled: true,
  announceToAgent: true,
  defaultHome: 'https://www.bing.com',
  maxTabs: 10,
  allowPrivateAccess: false,
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 160

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const BROWSER_GUIDANCE = '本机已安装 dsh-browser 插件（DSH 内置浏览器）：侧边栏「浏览器」入口，在 DSH Web GUI 内以 iframe 嵌入浏览网页（多标签、地址栏、前进/后退/刷新/主页、标签页按工作区持久化），新标签页可浏览并打开当前工作区的文件（宿主经 /api/dsh-browser/* 路由提供，工作区门禁 + loopback 围栏）。工具：browser_open 把网页推送到 GUI 浏览器面板供用户查看（无面板连接时不打开）；browser_read 抓取网页正文文本（仅静态 HTML 近似文本、不执行 JS）。限制：iframe 无法加载 X-Frame-Options/CSP 拒绝嵌入的站点；browser_read 默认拒绝内网/本机/私有地址（防 SSRF，设置中可解除）与超大响应；浏览会消耗真实网络流量，先确认再操作。用户提到「内置浏览器 / 打开网页 / 看网页 / 网页预览」时即指本插件，请据此协作。'

/**
 * Mount the routes, tools, settings namespace, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt/workspaceRegistry.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  // The live source the surfaces read: the settings section once the web
  // settings surface is served, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  const resolve = (): {
    enabled: boolean
    announceToAgent: boolean
    defaultHome: string
    maxTabs: number
    allowPrivateAccess: boolean
  } => ({
    enabled: current().enabled ?? DEFAULTS.enabled,
    announceToAgent: current().announceToAgent ?? DEFAULTS.announceToAgent,
    defaultHome: current().defaultHome ?? DEFAULTS.defaultHome,
    maxTabs: current().maxTabs ?? DEFAULTS.maxTabs,
    allowPrivateAccess: current().allowPrivateAccess ?? DEFAULTS.allowPrivateAccess,
  })

  const broadcaster = new OpenBroadcaster()
  ctx.effect(() => () => { broadcaster.dispose() }, 'dsh-browser: broadcaster')

  let disposeRoutes: (() => void) | undefined
  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  // Register (or drop) every surface to match the current source. Each group
  // is kept under one disposer: re-registering first tears the old one down
  // so duplicate-name registrations never throw.
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    const value = resolve()
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-browser',
        order: SECTION_ORDER,
        text: BROWSER_GUIDANCE,
      })
    }
    disposeRoutes = ctx.effect(
      () => registerBrowserRoutes(ctx, createWorkspaceGate(ctx), broadcaster),
      'dsh-browser: routes',
    )
    const tools = [
      browserOpenTool(url => broadcaster.push({ kind: 'open', url })),
      browserReadTool((url, maxChars) => readPage(url, value.allowPrivateAccess, maxChars)),
    ]
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-browser: tools',
    )
  }

  installSettingsSection(ctx, BROWSER_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()
}
