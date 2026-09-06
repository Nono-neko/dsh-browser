// @vitest-environment node
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenBroadcaster, registerBrowserRoutes } from '../src/host/routes.ts'
import { UpdateService } from '../src/host/update-service.ts'
import { UPDATE_PACKAGE } from '../src/core/updates.ts'

const disposers: (() => void)[] = []
const servers: Server[] = []
afterEach(async () => {
  disposers.splice(0).reverse().forEach(dispose => dispose())
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  })))
})

async function harness() {
  const network = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).includes('npmjs')
    ? { name: UPDATE_PACKAGE, version: '0.3.0' } : { tag_name: 'v0.3.0', draft: false, prerelease: false })))
  const updates = new UpdateService({ currentVersion: '0.2.0', installation: 'npm', fetch: network })
  updates.configure(true, false, false)
  disposers.push(() => updates.dispose())
  const handlers: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }[] = []
  const gate = vi.fn(async () => ({ ok: false as const, error: { code: 'workspace-unknown' as const, message: 'no workspace' } }))
  const ctx = {
    webServer: { register: (route: typeof handlers[number]) => { handlers.push(route); return () => {} } },
  } as unknown as Context
  disposers.push(registerBrowserRoutes(ctx, gate, new OpenBroadcaster(), {}, undefined, updates))
  const prefix = handlers.find(route => route.kind === 'prefix')!
  const server = createServer((req, res) => { void prefix.handler(req, res) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/dsh-browser', network, gate }
}

describe('loopback update routes', () => {
  it('reads cached status without a workspace and checks only through explicit POST', async () => {
    const { url, network, gate } = await harness()
    const status = await fetch(url + '/updates')
    expect(status.status).toBe(200)
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect((await status.json()).value.npm.state).toBe('unchecked')
    expect(network).not.toHaveBeenCalled()
    const result = await fetch(url + '/updates/check?url=http://127.0.0.1/private', { method: 'POST' })
    expect((await result.json()).value.npm.release.version).toBe('0.3.0')
    expect(network).toHaveBeenCalledTimes(2)
    expect(network.mock.calls.every(([target]) => String(target).startsWith('https://'))).toBe(true)
    expect(gate).not.toHaveBeenCalled()
    await fetch(url + '/updates/check', { method: 'POST' })
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('rejects cross-origin/opaque page requests, forged hosts, and unsupported methods before checking', async () => {
    const { url, network } = await harness()
    const forbiddenHeaders: Record<string, string>[] = [
      { origin: 'https://attacker.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { host: 'attacker.example' },
    ]
    for (const headers of forbiddenHeaders) {
      // Raw HTTP preserves forged Host headers that Fetch may normalize.
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(url + '/updates/check', { method: 'POST', headers }, response => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        })
        req.on('error', reject)
        req.end()
      })
      expect(status, JSON.stringify(headers)).toBe(403)
    }
    const wrongMethod = await fetch(url + '/updates/check')
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')
    expect((await fetch(url + '/updates', { method: 'POST' })).status).toBe(405)
    expect(network).not.toHaveBeenCalled()
  })
})
