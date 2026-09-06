/** Loopback-only access to plugin-wide, read-only release metadata. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { forbidden, isLoopbackRequest, json } from './http.ts'
import type { UpdateService } from './update-service.ts'

export async function handleUpdateRoute(req: IncomingMessage, res: ServerResponse, updates: UpdateService): Promise<void> {
  if (!isLoopbackRequest(req)) { forbidden(res); return }
  const path = new URL(req.url ?? '/', 'http://x').pathname
  res.setHeader('cache-control', 'no-store')
  if (path === '/api/dsh-browser/updates' && req.method === 'GET') {
    json(res, { ok: true, value: updates.getSnapshot() })
  } else if (path === '/api/dsh-browser/updates/check' && req.method === 'POST') {
    json(res, { ok: true, value: await updates.check(true) })
  } else {
    res.setHeader('allow', path.endsWith('/check') ? 'POST' : 'GET')
    json(res, { ok: false, error: { code: 'bad-request', message: 'method not allowed' } }, 405)
  }
}
