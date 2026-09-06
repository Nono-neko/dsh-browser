// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UPDATE_INTERVAL_MS, UPDATE_PACKAGE, availableUpdate } from '../src/core/updates.ts'
import { detectInstallation, UpdateService, type UpdateServiceOptions } from '../src/host/update-service.ts'

const local = 'a'.repeat(40)
const remote = 'b'.repeat(40)
const json = (body: unknown, headers?: HeadersInit) => new Response(JSON.stringify(body), { headers })
const npmRelease = { name: UPDATE_PACKAGE, version: '0.3.0' }
const githubRelease = { tag_name: 'v0.3.0', draft: false, prerelease: false, body: '<script>not executable</script>' }

function metadata(url: string): Response {
  if (url.includes('registry.npmjs.org')) return json(npmRelease, { etag: '"npm1"' })
  if (url.endsWith('/releases/latest')) return json(githubRelease, { etag: '"gh1"' })
  if (url.endsWith('/git/ref/heads/trunk')) return json({ ref: 'refs/heads/trunk', object: { type: 'commit', sha: remote } })
  if (url.includes('/compare/')) return json({ status: 'ahead', ahead_by: 3 })
  return json({ full_name: 'Nono-neko/dsh-browser', default_branch: 'trunk' })
}

const services: UpdateService[] = []
function service(fetchImpl: typeof fetch, overrides: Partial<UpdateServiceOptions> = {}) {
  const value = new UpdateService({ currentVersion: '0.2.0', installation: 'npm', fetch: fetchImpl, ...overrides })
  services.push(value)
  return value
}

afterEach(() => {
  services.splice(0).forEach(value => value.dispose())
  vi.useRealTimers()
})

describe('public update metadata service', () => {
  it('shares startup/concurrent work, caches for six hours, and rate-limits manual checks', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>(async url => metadata(String(url)))
    const updates = service(fetchImpl)
    updates.configure(true, true, false)
    const [first, second] = await Promise.all([updates.check(), updates.check(true)])
    expect(first).toEqual(second)
    expect(first.npm.release?.version).toBe('0.3.0')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await updates.check(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    await updates.check(true)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS)
    expect(fetchImpl).toHaveBeenCalledTimes(6)
  })

  it('honors opt-out and disabling, while allowing an explicit manual check', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async url => metadata(String(url)))
    const updates = service(fetchImpl)
    updates.configure(true, false, false)
    await updates.check()
    expect(fetchImpl).not.toHaveBeenCalled()
    await updates.check(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    updates.configure(false, true, false)
    await updates.check(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('reuses ETags and does not follow metadata redirects or trust supplied links', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      if ((options?.headers as Record<string, string>)['if-none-match']) return new Response(null, { status: 304 })
      return json(String(url).includes('npmjs') ? npmRelease : { ...githubRelease, html_url: 'javascript:bad()' }, { etag: '"version1"' })
    })
    const updates = service(fetchImpl)
    updates.configure(true, false, false)
    const initial = await updates.check(true)
    await vi.advanceTimersByTimeAsync(60_000)
    const cached = await updates.check(true)
    expect(cached.github).toEqual(initial.github)
    expect(cached.github.release?.url).toBe('https://github.com/Nono-neko/dsh-browser/releases/tag/v0.3.0')
    expect(cached.github.release?.notes).toBe(githubRelease.body)
    expect(fetchImpl.mock.calls.every(([, options]) => options?.redirect === 'error')).toBe(true)
    expect((fetchImpl.mock.calls[2][1]?.headers as Record<string, string>)['if-none-match']).toBe('"version1"')
  })

  it('uses a resolved default-branch tip, not the compare API first commit or a hard-coded branch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async url => metadata(String(url)))
    const updates = service(fetchImpl, { installation: 'source', currentRevision: local })
    updates.configure(true, false, true)
    const result = await updates.check(true)
    expect(result.repository).toMatchObject({ state: 'ok', comparison: 'ahead', revision: remote, branch: 'trunk' })
    expect(availableUpdate(result)?.key).toBe('repository:' + remote)
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toContain(
      'https://api.github.com/repos/Nono-neko/dsh-browser/compare/' + local + '...' + remote + '?per_page=1',
    )
  })

  it('does not compare missing build revisions or send workspace-derived data', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async url => metadata(String(url)))
    const updates = service(fetchImpl, { installation: 'source' })
    updates.configure(true, false, true)
    expect((await updates.check(true)).repository.state).toBe('uncomparable')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(detectInstallation('C:/app/node_modules/@nono-neko/dsh-browser')).toBe('npm')
    expect(detectInstallation('C:/unidentified-plugin-copy')).toBe('unknown')
  })

  it('distinguishes a missing public release from a network failure', async () => {
    const updates = service(vi.fn<typeof fetch>(async url => {
      if (String(url).includes('npmjs')) throw new Error('offline')
      return new Response(null, { status: 404 })
    }))
    updates.configure(true, false, false)
    const result = await updates.check(true)
    expect(result.npm.state).toBe('error')
    expect(result.github.state).toBe('empty')
    expect(availableUpdate(result)).toBeUndefined()
  })

  it.each([
    { name: UPDATE_PACKAGE, version: 'not-a-version' },
    { name: 'different-package', version: '0.3.0' },
    { name: UPDATE_PACKAGE, version: '0.3.0', oversized: 'x'.repeat(513 * 1024) },
  ])('rejects invalid or oversized metadata without retaining an offer', async body => {
    const updates = service(vi.fn<typeof fetch>(async url => String(url).includes('npmjs') ? json(body) : metadata(String(url))))
    updates.configure(true, false, false)
    const result = await updates.check(true)
    expect(result.npm.state).toBe('error')
    expect(availableUpdate(result)).toBeUndefined()
  })

  it('does not advertise prereleases even if npm latest points to one', async () => {
    const updates = service(vi.fn<typeof fetch>(async url => String(url).includes('npmjs')
      ? json({ ...npmRelease, version: '0.4.0-beta.1' }) : metadata(String(url))))
    updates.configure(true, false, false)
    expect((await updates.check(true)).npm.state).toBe('empty')
  })

  it('aborts in-flight work and does not reschedule checks after disposal', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const updates = service(fetchImpl)
    updates.configure(true, true, false)
    const pending = updates.check()
    updates.dispose()
    await pending
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(updates.getSnapshot()).toMatchObject({ checking: false, npm: { state: 'unchecked' } })
  })

  it('bounds hanging requests and restarts cancelled work after a channel change', async () => {
    vi.useFakeTimers()
    let hang = true
    const fetchImpl = vi.fn<typeof fetch>((url, options) => {
      if (!hang) return Promise.resolve(metadata(String(url)))
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const updates = service(fetchImpl, { installation: 'source', currentRevision: local })
    updates.configure(true, true, false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(updates.getSnapshot().npm.state).toBe('error')
    await vi.advanceTimersByTimeAsync(60_000)
    const pending = updates.check(true)
    hang = false
    updates.configure(true, true, true)
    await pending
    await vi.advanceTimersByTimeAsync(1)
    expect(updates.getSnapshot()).toMatchObject({
      checking: false, followRepository: true, repository: { state: 'ok', revision: remote },
    })
  })
})
