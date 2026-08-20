import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Build-artifact guard for the client bundle closure shape: the
 * module/exports declarations must sit INSIDE the factory function. A
 * bundler regression (e.g. tsdown emitting `intro` outside the banner) breaks
 * this and the GUI fails with "exports is not defined". `pnpm test` builds
 * first, so a missing artifact is a release-gate failure rather than a skip.
 */
describe('client bundle closure shape', () => {
  // vitest runs from the package root and rewrites import.meta.url, so the
  // artifact is resolved against cwd instead.
  const path = resolve(process.cwd(), 'lib/client.js')
  const source = readFileSync(path, 'utf8')
  const head = source.slice(0, 800)

  it('opens the __ModuleLoader__ handoff with the package id', () => {
    expect(head).toContain('window.__ModuleLoader__.load')
    expect(head).toContain('"@nono-neko/dsh-browser"')
    expect(head).toContain('factory: (require) =>')
  })

  it('declares module/exports inside the factory scope', () => {
    const factoryOpen = head.indexOf('factory: (require) =>')
    const varModule = head.indexOf('var module = { exports: {} }')
    const varExports = head.indexOf('var exports = module.exports')
    expect(varModule).toBeGreaterThan(factoryOpen)
    expect(varExports).toBeGreaterThan(varModule)
  })

  it('exports apply and inject', () => {
    expect(source).toContain('exports.apply = apply')
    expect(source).toContain('exports.inject = inject')
  })

  it('requires only modules supplied by the browser platform table', () => {
    const allowed = new Set([
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-web-react',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-schema-form',
      '@deepseek-ai/dsh-client-runtime/client',
    ])
    const required = [...source.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map(match => match[1])

    expect(required.filter(id => !allowed.has(id))).toEqual([])
  })
})
