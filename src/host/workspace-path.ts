/** Canonical workspace-relative path resolution shared by file APIs. */

import { realpath } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import type { BrowserError } from '../core/types.ts'
import { isPathInside } from './gate.ts'

export async function resolveInside(canonicalRoot: string, root: string, rel: string): Promise<
  { ok: true; abs: string; canonical: string }
  | { ok: false; error: BrowserError }
> {
  const joined = resolvePath(root, rel === '' ? '.' : rel)
  let canonical: string
  try {
    canonical = await realpath(joined)
  } catch {
    return { ok: false, error: { code: 'not-found', message: 'path does not resolve on disk' } }
  }
  if (!isPathInside(canonicalRoot, canonical)) {
    return { ok: false, error: { code: 'path-outside-root', message: 'path escapes the workspace root' } }
  }
  return { ok: true, abs: joined, canonical }
}
