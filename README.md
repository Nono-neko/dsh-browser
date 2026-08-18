# DSH Browser

English | [中文](README.zh.md)

> Embedded browser for the DSH Web GUI: browse the web and your workspace files
> inside the chat interface — multi-tab, address bar, per-workspace tab
> persistence — plus agent tools (`browser_open`, `browser_read`).

An external plugin package for DeepSeek Harness (DSH). It is a single
dual-face cordis bundle: the host half owns the agent tools, the
`/api/dsh-browser` route family (SSE open-event stream + workspace file
listing/serving), the settings namespace, and the system-prompt announcement;
the browser half renders the sidebar entry, the multi-tab panel, and the
plugin settings card. Hot-pluggable — mounted via
`dsh plugin --profile <name> add link:<repo>`, no dsh source changes.

## What it does

- **Entry**: a "Browser" row in the sidebar, below the New Session button.
- **Panel**: takes over the center column with a tab strip, a toolbar
  (back / forward / reload / home / open-in-system-browser), an address bar
  (URL or search, Enter opens), and an iframe content area. Inactive tabs stay
  mounted and stateful; iframes lazy-load on first activation.
- **Tabs per workspace**: the tab set is persisted per project root
  (localStorage, debounced + flushed on page hide). Switching sessions swaps
  the whole tab set; switching back restores it. A configurable cap (default
  10) trims the oldest inactive tab.
- **Workspace browsing**: the new-tab page lists the current workspace
  directory (folders navigate, breadcrumbs, up button); clicking a file opens
  it in the panel through the host's file route. HTML previews get a `<base>`
  injection so relative images/styles resolve, and a CSP `sandbox` header so a
  previewed file can never run scripts in the GUI origin.
- **Agent tools**: `browser_open` pushes a URL into the panel (a new tab opens
  and the panel gains focus); `browser_read` fetches a page from the host and
  returns extracted readable text (static-HTML approximation, no JavaScript).
- **Settings card**: the official Plugins settings section gets a
  "Embedded browser" card (enable, agent announcement, home page, tab cap,
  private-address override) with staged edits, save/discard, and
  inherit/reset semantics.
- **Agent announcement**: a system-prompt section tells every agent the plugin
  exists, what its tools do, and its limits (same mechanism dsh-ssh uses).

## Install

```sh
# from a local checkout (development)
dsh plugin --profile <name> add link:<repo>

# from npm (once published)
dsh plugin --profile <name> add @nono-neko/dsh-browser
```

Restart `dsh web`; the sidebar entry appears. The web profile needs the
`@deepseek-ai/*` client packages the bundle injects (any rc.6 web deployment
has them).

## Development

```sh
pnpm install    # @deepseek-ai/* SDK packages are public on npm (or a mirror)
pnpm build      # tsc types + tsdown dual-half bundle (lib/index.js + lib/client.js)
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest
```

The build emits two artifacts from one config: the node half (`lib/index.js`,
esm) and the browser half (`lib/client.js`, a `window.__ModuleLoader__`
closure-factory served at `/plugins/dsh-browser/client.js`). CSS Modules are
compiled into the client bundle by lightningcss; the client bundle enforces a
purity gate — value imports from `@deepseek-ai/*` are only allowed for the
platform seed modules, everything else must inline or go through cordis
services.

## Security model

- **Loopback fence**: every `/api/dsh-browser` route (SSE included) refuses
  non-loopback clients (socket address + Host header + same-origin markers).
  A LAN-exposed dsh web cannot serve workspace files or the event stream to
  unpaired devices.
- **Workspace gate**: file listing and serving canonicalize the requested root
  (realpath) and require it to be a registered workspace or inside one;
  every requested path is re-checked after resolution, so symlinks cannot
  escape the root.
- **Served HTML sandbox**: previewed HTML is served with
  `Content-Security-Policy: sandbox` — scripts never execute in the GUI
  origin (which holds the session's loopback API access).
- **SSRF guard on `browser_read`**: the target hostname is resolved through
  DNS before the request leaves the process and every address must be public
  (private/loopback/link-local/reserved ranges are refused). Redirects are
  followed manually and each hop is re-checked, so a public URL that
  redirects to an internal address cannot bypass the guard. The
  `allowPrivateAccess` setting is an explicit override; the risk is yours.
- **Size/time caps**: bodies over 2 MB answer an error before being read;
  served workspace files over 64 MB are refused; each fetch hop times out
  after 15 seconds.

## Limitations

- The panel embeds pages in an iframe: sites that send
  `X-Frame-Options` / CSP `frame-ancestors` refuse to load. The start page,
  the address bar, and `browser_read` keep working for those sites.
- Back/forward covers URLs entered through the address bar; in-page clicks
  inside a cross-origin iframe are invisible to the panel (the parent cannot
  read the iframe's location).
- `browser_read` sees only the static HTML: JavaScript-rendered pages come
  back without their client-side content, and it cannot use your logins.
- Browsing consumes real network traffic.

## License

Apache-2.0
