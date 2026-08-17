/**
 * Translator seam for non-React surfaces (the sidebar entry row is plain
 * DOM). The locale-bound translator is installed by the client entry during
 * apply; before that, keys render verbatim (the entry mounts after bind).
 * @module dsh-browser/client/translate
 */

let current: ((key: string) => string) | undefined

/** Install the locale-bound translator. */
export function setTranslator(t: (key: string) => string): void {
  current = t
}

/** Translate one key outside React. */
export function tt(key: string): string {
  return current !== undefined ? current(key) : key
}
