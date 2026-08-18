/**
 * Standalone tsdown config for the dsh-browser package — one config array
 * emitting both halves:
 *
 * - the node half `lib/index.js` (esm, `@deepseek-ai/cordis` external,
 *   resolved at runtime from the dsh profile tree; everything else inlined);
 * - the browser half `lib/client.js`, a closure-factory artifact:
 *   `window.__ModuleLoader__.load({ id, factory })` with externals resolved
 *   through the loader module table (the platform seed list below — cordis DI
 *   entities, no globals, no import map). CSS Modules are compiled by
 *   lightningcss inside the bundle: importing `x.module.css` yields the hashed
 *   class map, and the css text auto-injects a `<style data-plugin>` tag at
 *   factory execution.
 *
 * Modeled on the dsh-web-ui family's shared tsdown preset (Apache-2.0),
 * reduced to what a single standalone package needs.
 */
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** The package id, stamped into the loader handoff and style tags. */
const ID = '@nono-neko/dsh-browser'

/** Browser platform seed table (mirrors the shell's frozen module table). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/**
 * Documented exemption (not a platform module): the snapshot-store engine
 * lives in runtime pending its promotion-time rehoming. Not used by this
 * package today, kept so the externals list matches the shell's reality.
 */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/**
 * Wire/type layers a client bundle may inline: browser-safe contract surfaces
 * with no runtime identity to share. Everything else under @deepseek-ai/* is
 * either a module-table entry (external) or a leak the purity gate rejects.
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Repo-relative id for one stylesheet (stable across machines). */
function relativeId(physical: string): string {
  if (!isAbsolute(physical)) return physical
  const rebased = relative(PACKAGE_ROOT, physical).split(sep).join('/')
  return rebased.startsWith('../') ? physical : rebased
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (emitted.startsWith(PACKAGE_ROOT)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

/** The node-half library config. */
const libConfig: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Every @deepseek-ai/* value import stays external: the dsh profile tree
  // owns the runtime instances (the same stance the dsh-web-ui family takes
  // in its node-half builds). Local code and non-SDK deps inline.
  external: [/^@deepseek-ai\//],
}

/** The browser-half closure-factory config. */
const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // Browser bundle lands next to the node half (single lib/ artifact dir);
  // clean must stay off so it never wipes the node-half output.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // Browser bundles inline node-idiom deps that probe NODE_ENV / import.meta.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // Anything NOT in the loader module table must inline: a require() the
  // table cannot answer is a guaranteed runtime throw.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    // Bundle purity gate (build-time mirror of the module-edge rules):
    // platform seed entries stay external, inline-safe wire layers inline,
    // and every other @deepseek-ai value import is a build error.
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }, {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + relativeId(abs) + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const physical = isAbsolute(fileId) ? fileId : resolvePath(PACKAGE_ROOT, fileId)
      this.addWatchFile(physical)
      const source = await readFile(physical)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      // Sort deterministically: lightningcss's export iteration order is
      // process-dependent (hash-map seeds).
      for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        classMap[local] = exp.name
      }
      // One <style data-plugin> per module file; idempotent under re-evaluation.
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${ID}/${fileId}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    // The module/exports declarations are part of the banner (inside the
    // factory scope), NOT a separate `intro`: newer tsdown versions emit
    // `intro` outside the factory, which breaks the closure with
    // "exports is not defined" at load time.
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;`,
    footer: 'return module.exports; } });',
  },
}

export default [libConfig, clientConfig]
