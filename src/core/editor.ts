/** Shared wire contracts for the lightweight workspace source editor. */

export interface SourceDocument {
  root: string
  path: string
  content: string
  hash: string
  size: number
  mtimeMs: number
}

export interface SourceWrite {
  workspaceRoot: string
  path: string
  content: string
  expectedHash: string
}

const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  'apng',
  'avif',
  'bmp',
  'gif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
])

/** Whether the lightweight editor should open a file as an image preview. */
export function isPreviewableImage(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? ''
  const separator = name.lastIndexOf('.')
  return separator > 0 && PREVIEWABLE_IMAGE_EXTENSIONS.has(name.slice(separator + 1).toLowerCase())
}
