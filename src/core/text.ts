/**
 * HTML to readable text extraction for browser_read. Pure string logic (no
 * DOM, no node imports — this compiles into both bundles and runs against
 * host-fetched HTML).
 * @module dsh-browser/core/text
 */

/** Tag names whose whole content is dropped before text extraction. */
const STRIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head'])

/** Tags that force a line break when opened or closed. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'tr', 'br',
  'blockquote', 'pre', 'form', 'fieldset', 'hr', 'figure', 'figcaption',
  'details', 'summary', 'dl', 'dt', 'dd',
])

/** Characters that act as list bullet replacement for li elements. */
const BULLET = '-'

/**
 * Extract the document title: the <title> element, falling back to the first
 * h1. Returns undefined when neither exists.
 */
export function extractTitle(html: string): string | undefined {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (title !== null) {
    const decoded = decodeEntities(title[1].trim())
    if (decoded !== '') return decoded
  }
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  if (h1 !== null) {
    const decoded = decodeEntities(collapseSpaces(stripInlineTags(h1[1])).trim())
    if (decoded !== '') return decoded
  }
  return undefined
}

/**
 * Convert HTML into compact readable text: strips script/style trees, turns
 * block boundaries into newlines, keeps li bullets, decodes entities and
 * collapses whitespace. Best-effort by design — browser_read output is a
 * reading aid, not a parse tree.
 */
export function extractText(html: string, maxChars: number): { text: string; truncated: boolean } {
  const body = removeStrippedTrees(html)
  const lines: string[] = []
  let current = ''
  let truncated = false
  let prevWasBlock = true

  const flush = (): void => {
    const trimmed = collapseSpaces(current).trim()
    if (trimmed !== '') {
      if (lines.length === 0) lines.push(trimmed)
      else if (!prevWasBlock) lines.push(trimmed)
      else {
        // A block boundary directly after another block adds no empty line;
        // merge into the previous line keeps the output compact.
        lines[lines.length - 1] += ` ${trimmed}`
      }
    }
    current = ''
  }

  const tokenize = /<[^>]*>|[^<]+/g
  let match: RegExpExecArray | null
  while ((match = tokenize.exec(body)) !== null) {
    const piece = match[0]
    if (piece.startsWith('<')) {
      const close = piece.startsWith('</')
      const tag = /^<\/?\s*([a-z0-9]+)/i.exec(piece)?.[1]?.toLowerCase() ?? ''
      if (tag === 'li') {
        // The bullet prefix belongs to the CONTENT between <li> and </li>:
        // flush the previous line, then seed the prefix (open) or finish the
        // line (close).
        flush()
        if (!close) {
          current = `${BULLET} `
          prevWasBlock = true
        }
        continue
      }
      if (BLOCK_TAGS.has(tag)) {
        flush()
        prevWasBlock = true
      }
      continue
    }
    const text = decodeEntities(piece)
    if (text.trim() !== '' || current !== '') {
      current += text
      prevWasBlock = false
    }
  }
  flush()

  let text = lines.join('\n')
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  return { text, truncated }
}

/** Strip inline tags from a short fragment (used by the title fallback). */
function stripInlineTags(fragment: string): string {
  return fragment.replace(/<[^>]*>/g, ' ')
}

/** Collapse every whitespace run into one space (used by the title path too). */
function collapseSpaces(input: string): string {
  return input.replace(/\s+/g, ' ')
}

/** Drop whole element trees whose tags are in the strip set. */
function removeStrippedTrees(html: string): string {
  let result = html
  for (const tag of STRIP_TAGS) {
    // Repeatedly remove the innermost occurrence until none remain.
    const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi')
    const close = new RegExp(`</${tag}>`, 'gi')
    let guard = 0
    while (guard < 100) {
      const next = removeOneTree(result, open, close)
      if (next === result) break
      result = next
      guard += 1
    }
  }
  return result
}

/** Remove the first pair of matching open/close tags plus everything between. */
function removeOneTree(input: string, open: RegExp, close: RegExp): string {
  const start = open.exec(input)
  if (start === null) return input
  const end = close.exec(input.slice(start.index + start[0].length))
  if (end === null) return input
  const from = start.index
  const to = start.index + start[0].length + end.index + end[0].length
  return input.slice(0, from) + input.slice(to)
}

/** Decode the common HTML entities plus numeric forms. */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code: string) => {
      const value = Number(code)
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const value = Number.parseInt(code, 16)
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
