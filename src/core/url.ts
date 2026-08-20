/**
 * URL helpers shared by the host tools and the browser-half address bar.
 * Pure string/number logic only (no node imports — this compiles into both
 * bundles).
 * @module dsh-browser/core/url
 */

/**
 * Normalize a user-typed address into a loadable URL. Bare words are treated
 * as search queries for the default search engine; anything containing a dot
 * or a scheme becomes an http(s) URL.
 * @param input - raw address-bar text.
 * @returns a normalized http/https URL, or null when the input is empty.
 */
export function normalizeAddress(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    const parsed = tryParseHttp(trimmed)
    return parsed ?? null
  }
  if (lower.startsWith('file:') || lower.startsWith('javascript:') || lower.startsWith('data:')) {
    // iframes must never load these from the address bar.
    return null
  }
  if (/^(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|\[[0-9a-f:.]+\]):\d+(?:[/?#]|$)/i.test(trimmed)) {
    return tryParseHttp(`https://${trimmed}`)
  }
  if (/^[a-z][a-z0-9+.-]*:/.test(lower)) {
    // Unknown scheme: refuse rather than guess.
    return null
  }
  if (trimmed.includes('.') && !trimmed.includes(' ')) {
    const parsed = tryParseHttp(`https://${trimmed}`)
    return parsed ?? null
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`
}

/** Parse an http(s) URL; null when the input is not a valid http(s) URL. */
export function tryParseHttp(input: string): string | null {
  try {
    const url = new URL(input)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.hostname === '') return null
    return url.toString()
  } catch {
    return null
  }
}

/** Whether a stored tab URL is http(s) (anything else opens the start page instead). */
export function isHttpUrl(input: string): boolean {
  return tryParseHttp(input) !== null
}

/**
 * A short display label for a tab: the hostname for http(s) URLs, the
 * relative path for workspace-file URLs, or the URL itself when neither fits.
 */
export function displayLabel(url: string): string {
  if (url.startsWith('/api/dsh-browser/file')) {
    try {
      const parsed = new URL(url, 'http://x')
      const root = parsed.searchParams.get('root') ?? ''
      const path = parsed.searchParams.get('path') ?? ''
      const base = root.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? 'workspace'
      return path === '' ? base : `${base}/${path.replaceAll('\\', '/').split('/').pop()}`
    } catch {
      return 'file'
    }
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname + (parsed.pathname === '/' ? '' : parsed.pathname)
    }
  } catch {
    // fall through
  }
  return url
}

/** Sort key for tabs: workspace files first, then by label (stable UX). */
export function tabSortKey(url: string): string {
  return `${url.startsWith('/api/dsh-browser/file') ? '0' : '1'}${displayLabel(url).toLowerCase()}`
}

/**
 * Wrap an http(s) URL in the browser proxy route so it loads through the dsh
 * host (which strips X-Frame-Options / CSP frame-ancestors). Workspace-file
 * URLs (relative or same-origin absolute), other /api/dsh-browser/* routes,
 * and non-http URLs pass through unchanged — they are same-origin or never
 * need proxying.
 */
export function toProxyUrl(url: string): string {
  if (url.startsWith('/api/dsh-browser/')) return url
  const parsed = tryParseHttp(url)
  if (parsed === null) return url
  try {
    const u = new URL(parsed)
    if (u.pathname.startsWith('/api/dsh-browser/')) return url
  } catch {
    // fall through to proxy
  }
  return `/api/dsh-browser/proxy?url=${encodeURIComponent(url)}`
}
