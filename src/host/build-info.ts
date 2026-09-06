/** Stamped at build time: the running bundle, not a subsequently changed checkout. */
declare const __DSH_BROWSER_VERSION__: string
declare const __DSH_BROWSER_REVISION__: string | undefined

export const BUILD_VERSION = typeof __DSH_BROWSER_VERSION__ === 'string' ? __DSH_BROWSER_VERSION__ : 'unknown'
export const BUILD_REVISION = typeof __DSH_BROWSER_REVISION__ === 'string' ? __DSH_BROWSER_REVISION__ : undefined
