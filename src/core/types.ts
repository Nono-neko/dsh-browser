/**
 * Shared wire types between the host half and the browser half. Pure types
 * only — this module compiles into both bundles and must stay side-effect free.
 * @module dsh-browser/core/types
 */

/** One SSE event pushed from the host to every connected GUI panel. */
export type BrowserEvent = { kind: 'open'; url: string }

/** JSON envelope shared by every /api/dsh-browser JSON operation. */
export type BrowserEnvelope<T> = { ok: true; value: T } | { ok: false; error: BrowserError }

/** Stable error codes the client surfaces as friendly copy. */
export interface BrowserError {
  code:
    | 'internal'
    | 'bad-request'
    | 'workspace-unknown'
    | 'path-outside-root'
    | 'not-found'
    | 'is-directory'
    | 'too-large'
  message: string
}

/** One directory entry in a workspace listing. */
export interface WorkspaceEntry {
  name: string
  kind: 'dir' | 'file' | 'other'
  size: number | undefined
}

/** A workspace listing page (folder navigation state). */
export interface WorkspaceListing {
  /** Canonical workspace root the listing is anchored to. */
  root: string
  /** Path relative to the root; '' is the root itself. */
  path: string
  entries: WorkspaceEntry[]
}

/** Plugin config, validated by the same-named schemastery schema in the host half. */
export interface BrowserConfig {
  /** Master switch (tools, routes, prompt section, browser half surfaces). */
  enabled?: boolean
  /** When true, a system-prompt section announces the plugin to every agent. */
  announceToAgent?: boolean
  /** Home button target; defaults to https://www.bing.com. */
  defaultHome?: string
  /** Maximum number of tabs kept per workspace (oldest trimmed). */
  maxTabs?: number
  /** When true, browser_read may fetch private-range addresses (SSRF override). */
  allowPrivateAccess?: boolean
  /** Path to a Chromium-compatible executable; auto-detected when empty. */
  browserExecutable?: string
  /** Proxy server passed to Chromium as --proxy-server, e.g. http://127.0.0.1:7890. */
  proxyServer?: string
}

/** The result of one browser_read fetch, as rendered to the agent. */
export interface ReadResult {
  ok: boolean
  url: string
  status: number | undefined
  contentType: string | undefined
  title: string | undefined
  text: string
  truncated: boolean
  error: string | undefined
}

/** The result of one browser_open broadcast, as rendered to the agent. */
export interface OpenResult {
  opened: boolean
  url: string
  message: string
}
