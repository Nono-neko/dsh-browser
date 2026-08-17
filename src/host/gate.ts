/**
 * Workspace gate for the /api/dsh-browser routes: canonicalize the requested
 * project root and require it to be a registered workspace (or a directory
 * inside one). This is the security boundary of the file routes — the browser
 * may only list and read files under registered workspace roots, never
 * arbitrary host directories.
 *
 * Adapted from the dsh-web-ui family's dsh-aionui-panel gate (Apache-2.0).
 * @module dsh-browser/host/gate
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type { BrowserError } from '../core/types.ts'

/** The gate verdict for one project root. */
export type GateVerdict = { ok: true; canonical: string } | { ok: false; error: BrowserError }

/** The workspace-membership check the routes run on every request. */
export type WorkspaceGate = (root: string) => Promise<GateVerdict>

/**
 * Normalize a path for prefix comparison: collapse Windows separators to `/`
 * and drop any trailing slash. On win32 the whole path is also lower-cased so
 * a case-insensitive FS cannot trip the membership check.
 */
export function normalizeForPrefix(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * The canonical prefix check: child must live inside (or equal) the root.
 * Separator- and case-robust on Windows (both sides are normalized to
 * forward slashes before comparing, case-insensitively on win32).
 */
export function isPathInside(root: string, child: string): boolean {
  if (root === '' || child === '') return false
  const normRoot = normalizeForPrefix(root)
  const normChild = normalizeForPrefix(child)
  if (normChild === normRoot) return true
  return normChild.startsWith(`${normRoot}/`)
}

/**
 * Production gate: canonicalize the requested root and require it to be a
 * registered workspace path (or a subdirectory of one). The host's workspace
 * registry owns canonicalization, so an unowned path is rejected outright.
 * @param ctx - context carrying the workspace service.
 * @returns the gate.
 */
export function createWorkspaceGate(ctx: Context): WorkspaceGate {
  return async (root) => {
    if (typeof root !== 'string' || root === '') {
      return { ok: false, error: { code: 'workspace-unknown', message: 'empty project root' } }
    }
    let canonical: string
    try {
      canonical = await realpath(root)
    } catch {
      return { ok: false, error: { code: 'workspace-unknown', message: 'path does not resolve on disk' } }
    }
    const workspaces = ctx.workspaceRegistry.list()
    for (const workspace of workspaces) {
      if (isPathInside(workspace.path, canonical)) {
        return { ok: true, canonical }
      }
    }
    return { ok: false, error: { code: 'workspace-unknown', message: 'path is not inside a registered workspace' } }
  }
}
