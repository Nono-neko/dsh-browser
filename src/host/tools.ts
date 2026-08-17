/**
 * Agent tools: browser_open pushes a URL into the GUI browser panel (through
 * the SSE broadcaster), browser_read fetches a page from the host and returns
 * extracted readable text. The same surfaces the web UI uses, so anything an
 * agent opens is immediately visible to the user and vice versa.
 * @module dsh-browser/host/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { extractText, extractTitle } from '../core/text.ts'
import { tryParseHttp } from '../core/url.ts'
import type { ReadResult } from '../core/types.ts'
import { assertPublicHost } from './ssrf-guard.ts'
import type { OpenBroadcaster } from './routes.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** User agent identifying the plugin on the wire. */
const USER_AGENT = 'dsh-browser/0.1 (DSH Web GUI embedded browser agent tool)'

/** Redirect hops followed before giving up (each hop re-runs the SSRF guard). */
const MAX_REDIRECTS = 5

/** Hard cap on a fetched body (answers too-large before reading). */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** Fetch timeout per hop. */
const FETCH_TIMEOUT_MS = 15_000

/** Redirect statuses followed manually. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Content types browser_read accepts as text. */
const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|x-httpd-php))/i

/** One fetch attempt outcome. */
export type FetchOutcome =
  | { ok: true; res: Response; finalUrl: string }
  | { ok: false; error: string }

/** Timeout signal per hop; undefined when the realm lacks AbortSignal.timeout (jsdom tests). */
function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  const anySignal = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
  return typeof anySignal.timeout === 'function' ? anySignal.timeout(timeoutMs) : undefined
}

/**
 * Fetch a URL with the SSRF guard applied to every hop (including redirects,
 * which fetch's redirect: 'follow' would have resolved itself). Exported for
 * direct unit testing.
 */
export async function fetchGuarded(
  input: string,
  allowPrivate: boolean,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<FetchOutcome> {
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS
  let current = input
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed: URL
    try {
      parsed = new URL(current)
    } catch {
      return { ok: false, error: `invalid URL: ${current}` }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'only http(s) URLs are supported' }
    }
    if (!allowPrivate) {
      const problem = await assertPublicHost(parsed.hostname)
      if (problem !== undefined) {
        return { ok: false, error: `refused by the private-address guard: ${problem}` }
      }
    }
    let res: Response
    try {
      res = await doFetch(parsed, {
        redirect: 'manual',
        signal: timeoutSignal(timeoutMs),
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        },
      })
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError'
        ? 'timed out'
        : error instanceof Error ? error.message : String(error)
      return { ok: false, error: `fetch failed: ${reason}` }
    }
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location')
      void res.body?.cancel()
      if (location === null) return { ok: true, res, finalUrl: current }
      current = new URL(location, parsed).toString()
      continue
    }
    return { ok: true, res, finalUrl: current }
  }
  return { ok: false, error: 'too many redirects' }
}

/** Read one page into the shared result shape. Exported for unit testing. */
export async function readPage(
  input: string,
  allowPrivate: boolean,
  maxChars: number,
  deps: { fetch?: typeof fetch } = {},
): Promise<ReadResult> {
  const base: ReadResult = {
    ok: false, url: input, status: undefined, contentType: undefined,
    title: undefined, text: '', truncated: false, error: undefined,
  }
  const outcome = await fetchGuarded(input, allowPrivate, { fetch: deps.fetch })
  if (!outcome.ok) return { ...base, error: outcome.error }
  const { res, finalUrl } = outcome
  base.url = finalUrl
  base.status = res.status
  base.contentType = res.headers.get('content-type') ?? undefined
  if (!res.ok) {
    base.error = `HTTP ${res.status}`
    return base
  }
  const length = res.headers.get('content-length')
  if (length !== null && Number(length) > MAX_BODY_BYTES) {
    base.error = `body exceeds the ${MAX_BODY_BYTES} byte cap`
    return base
  }
  const contentType = base.contentType ?? ''
  if (!TEXT_TYPES.test(contentType) && contentType !== '') {
    base.error = `unsupported content type: ${contentType}`
    return base
  }
  const body = await res.text()
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    base.error = `body exceeds the ${MAX_BODY_BYTES} byte cap`
    return base
  }
  if (/html/i.test(contentType)) {
    base.title = extractTitle(body)
    const extracted = extractText(body, maxChars)
    base.text = extracted.text
    base.truncated = extracted.truncated
  } else {
    base.text = body.length > maxChars ? body.slice(0, maxChars) : body
    base.truncated = body.length > maxChars
  }
  base.ok = true
  return base
}

/** Render one read result compactly. */
function renderRead(result: ReadResult): string {
  const head = [
    `${result.ok ? 'ok' : 'failed'}: ${result.url}`,
    result.status !== undefined ? `status: ${result.status}` : null,
    result.contentType !== undefined ? `content-type: ${result.contentType}` : null,
    result.error !== undefined ? `error: ${result.error}` : null,
  ].filter((line): line is string => line !== null)
  if (!result.ok) return head.join('\n')
  if (result.title !== undefined && result.title !== '') head.push(`title: ${result.title}`)
  const tail = result.truncated ? `\n(text truncated to the requested length)` : ''
  return `${head.join('\n')}\n--- text ---\n${result.text}${tail}`
}

/** The open-in-panel tool. */
export function browserOpenTool(push: (url: string) => number) {
  return defineTool({
    name: 'browser_open',
    description: 'Open a web page in the DSH browser panel (the embedded browser in the web GUI) for the user to see. ' +
      'Triggers: open a page, show a website, preview a URL, browse. Only http(s) URLs are supported; the page opens in a new tab and the panel gains focus.',
    parameters: {
      url: { type: 'string', required: true, description: 'The http(s) URL to open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          opened: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value: { opened?: boolean; url?: string; message?: string }) =>
        text(`${value.opened === true ? 'opened' : 'not opened'}: ${value.url ?? ''} — ${value.message ?? ''}`),
    },
    async execute(args) {
      const raw = String(args.url ?? '')
      const url = tryParseHttp(raw)
      if (url === null) {
        return { opened: false, url: raw, message: 'only http(s) URLs can be opened in the panel' }
      }
      const delivered = push(url)
      return {
        opened: delivered > 0,
        url,
        message: delivered > 0
          ? 'opened in the DSH browser panel'
          : 'no GUI panel is connected — the page was not opened',
      }
    },
  })
}

/** The page-reading tool. */
export function browserReadTool(read: (url: string, maxChars: number) => Promise<ReadResult>) {
  return defineTool({
    name: 'browser_read',
    description: 'Fetch a web page and return its readable text (title + body text extracted from static HTML; no JavaScript execution). ' +
      'Use it to read articles, documentation, or any web content for the user. ' +
      'Triggers: read a web page, fetch a URL, check a website, what does this page say. ' +
      'Private/internal addresses are refused by default (SSRF guard); only http(s) URLs are supported.',
    parameters: {
      url: { type: 'string', required: true, description: 'The http(s) URL to read.' },
      maxChars: { type: 'integer', description: 'Maximum characters of text to return (default 12000, max 100000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          status: { type: 'integer' },
          contentType: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: ReadResult) => text(renderRead(value)),
    },
    async execute(args) {
      const raw = String(args.url ?? '')
      const requested = Number(args.maxChars ?? 12000)
      const maxChars = Number.isFinite(requested)
        ? Math.min(100_000, Math.max(500, Math.floor(requested)))
        : 12000
      return read(raw, maxChars)
    },
  })
}
