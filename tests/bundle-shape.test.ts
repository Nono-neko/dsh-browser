import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Build-artifact guard for the client bundle closure shape: the
 * module/exports declarations must sit INSIDE the factory function. A
 * bundler regression (e.g. tsdown emitting `intro` outside the banner) breaks
 * this and the GUI fails with "exports is not defined". The test skips when
 * lib/client.js has not been built yet (fresh clone before the first build).
 */
describe('client bundle closure shape', () => {
  // vitest runs from the package root and rewrites import.meta.url, so the
  // artifact is resolved against cwd instead.
  const path = resolve(process.cwd(), 'lib/client.js')
  if (!existsSync(path)) {
    it.skip('lib/client.js not built yet', () => {})
    return
  }
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
})
