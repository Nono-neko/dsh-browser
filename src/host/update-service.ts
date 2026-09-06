/**
 * Host-owned release checks. Only fixed public metadata endpoints are fetched;
 * no installation, shell execution, or workspace access is exposed over HTTP.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  isStableVersion, isValidVersion, NPM_URL, REPOSITORY_URL, UPDATE_INTERVAL_MS,
  UPDATE_PACKAGE, UPDATE_REPOSITORY,
  type InstallationSource, type RepositoryCheck, type UpdateSnapshot, type VersionCheck,
} from '../core/updates.ts'

const NPM_LATEST = 'https://registry.npmjs.org/@nono-neko%2Fdsh-browser/latest'
const GITHUB_API = 'https://api.github.com/repos/Nono-neko/dsh-browser'
const MANUAL_COOLDOWN_MS = 60_000
const MAX_METADATA_BYTES = 512 * 1024
const TIMEOUT_MS = 10_000

export interface UpdateServiceOptions {
  currentVersion: string
  currentRevision?: string
  installation: InstallationSource
  fetch?: typeof fetch
  now?: () => number
}

/** Identify the package's own directory, never the current project workspace. */
export function detectInstallation(packageRoot: string): InstallationSource {
  if (existsSync(join(packageRoot, '.git'))) return 'source'
  if (packageRoot.split(/[\\/]/).includes('node_modules')) return 'npm'
  return 'unknown'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function bounded(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length <= limit ? value : undefined
}

function publishedAt(value: unknown): string | undefined {
  const date = bounded(value, 64)
  return date && Number.isFinite(Date.parse(date)) ? date : undefined
}

interface CachedMetadata { etag?: string; body: unknown }

export class UpdateService {
  private state: UpdateSnapshot
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly cache = new Map<string, CachedMetadata>()
  private running?: Promise<UpdateSnapshot>
  private controller?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private enabled = false
  private disposed = false

  constructor(options: UpdateServiceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.state = {
      currentVersion: options.currentVersion,
      currentRevision: options.currentRevision,
      installation: options.installation,
      autoCheck: false,
      followRepository: false,
      checking: false,
      npm: { state: 'unchecked' },
      github: { state: 'unchecked' },
      repository: { state: 'unchecked' },
    }
  }

  getSnapshot(): UpdateSnapshot { return structuredClone(this.state) }

  configure(enabled: boolean, autoCheck: boolean, followRepository: boolean): void {
    const changedChannel = this.state.followRepository !== followRepository
    const stoppedAutoCheck = this.state.autoCheck && !autoCheck
    this.enabled = enabled
    this.state = { ...this.state, autoCheck, followRepository }
    if (changedChannel) this.state = { ...this.state, checkedAt: undefined, repository: { state: 'unchecked' } }
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!enabled || stoppedAutoCheck || changedChannel) this.controller?.abort()
    if (!enabled || !autoCheck || this.disposed) return
    // Leave apply synchronous; settings refreshes share the existing result.
    if (this.running && this.controller?.signal.aborted) {
      // Restart in the new channel only after the cancelled requests settle.
      void this.running.then(() => { void this.check() })
    } else {
      void this.check()
    }
  }

  /** Concurrent checks share one promise; manual refresh is bounded to once/minute. */
  check(manual = false): Promise<UpdateSnapshot> {
    if (this.running) return this.running
    if (this.disposed || !this.enabled || (!manual && !this.state.autoCheck)) return Promise.resolve(this.getSnapshot())
    const minimumAge = manual ? MANUAL_COOLDOWN_MS : UPDATE_INTERVAL_MS
    if (this.state.checkedAt !== undefined && this.now() - this.state.checkedAt < minimumAge) {
      this.schedule()
      return Promise.resolve(this.getSnapshot())
    }
    this.controller = new AbortController()
    const signal = this.controller.signal
    const followRepository = this.state.followRepository && this.state.installation === 'source'
    this.state = { ...this.state, checking: true }
    this.running = (async () => {
      const [npm, github, repository] = await Promise.all([
        this.readNpm(signal), this.readGithub(signal),
        followRepository ? this.readRepository(signal) : Promise.resolve<RepositoryCheck>({ state: 'unchecked' }),
      ])
      if (!signal.aborted && !this.disposed) {
        this.state = { ...this.state, npm, github, repository, checkedAt: this.now() }
      }
      this.state = { ...this.state, checking: false }
      return this.getSnapshot()
    })().finally(() => {
      this.running = undefined
      this.controller = undefined
      this.schedule()
    })
    return this.running
  }

  dispose(): void {
    this.disposed = true
    this.controller?.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.enabled || !this.state.autoCheck || this.disposed) return
    const age = this.state.checkedAt === undefined ? 0 : this.now() - this.state.checkedAt
    this.timer = setTimeout(() => { void this.check() }, Math.max(1_000, UPDATE_INTERVAL_MS - age))
    this.timer.unref?.()
  }

  private async metadata(url: string, parentSignal: AbortSignal): Promise<unknown> {
    const cached = this.cache.get(url)
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (parentSignal.aborted) controller.abort()
    else parentSignal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, TIMEOUT_MS)
    timeout.unref?.()
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'user-agent': UPDATE_PACKAGE + '/' + this.state.currentVersion,
      }
      if (cached?.etag) headers['if-none-match'] = cached.etag
      const response = await this.fetch(url, { headers, signal: controller.signal, redirect: 'error' })
      if (response.status === 304 && cached) return cached.body
      if (response.status === 404) {
        this.cache.delete(url)
        await response.body?.cancel()
        return undefined
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error('update metadata unavailable')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_METADATA_BYTES) throw new Error('update metadata too large')
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
        reader.releaseLock()
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (this.cache.size >= 8 && !this.cache.has(url)) this.cache.delete(this.cache.keys().next().value as string)
      this.cache.set(url, { etag: response.headers.get('etag') ?? undefined, body })
      return body
    } finally {
      clearTimeout(timeout)
      parentSignal.removeEventListener('abort', abort)
    }
  }

  private async readNpm(signal: AbortSignal): Promise<VersionCheck> {
    try {
      const raw = await this.metadata(NPM_LATEST, signal)
      if (raw === undefined) return { state: 'empty' }
      const data = record(raw)
      const version = bounded(data?.version, 200)
      if (data?.name !== UPDATE_PACKAGE || !version || !isValidVersion(version)) return { state: 'error' }
      if (!isStableVersion(version)) return { state: 'empty' }
      return { state: 'ok', release: { version, url: NPM_URL + '/v/' + encodeURIComponent(version) } }
    } catch { return { state: 'error' } }
  }

  private async readGithub(signal: AbortSignal): Promise<VersionCheck> {
    try {
      const raw = await this.metadata(GITHUB_API + '/releases/latest', signal)
      if (raw === undefined) return { state: 'empty' }
      const data = record(raw)
      const tag = bounded(data?.tag_name, 200)
      if (!tag || !isValidVersion(tag) || data?.draft !== false || data?.prerelease !== false) return { state: 'error' }
      if (!isStableVersion(tag)) return { state: 'empty' }
      return {
        state: 'ok',
        release: {
          version: tag.replace(/^v/, ''),
          url: REPOSITORY_URL + '/releases/tag/' + encodeURIComponent(tag),
          notes: typeof data.body === 'string' ? data.body.slice(0, 12_000) : undefined,
          publishedAt: publishedAt(data.published_at),
        },
      }
    } catch { return { state: 'error' } }
  }

  private async readRepository(signal: AbortSignal): Promise<RepositoryCheck> {
    const local = this.state.currentRevision
    if (!local || !/^[a-f0-9]{40}$/.test(local)) return { state: 'uncomparable' }
    try {
      const info = record(await this.metadata(GITHUB_API, signal))
      const branch = bounded(info?.default_branch, 255)
      if (!branch || info?.full_name !== UPDATE_REPOSITORY) return { state: 'error' }
      // Resolve the branch tip first. The compare API has no head_commit field,
      // and its paginated commits array need not include the tip.
      const ref = record(await this.metadata(GITHUB_API + '/git/ref/heads/' + encodeURIComponent(branch), signal))
      const object = record(ref?.object)
      const revision = bounded(object?.sha, 40)
      if (ref?.ref !== 'refs/heads/' + branch || object?.type !== 'commit'
        || !revision || !/^[a-f0-9]{40}$/.test(revision)) return { state: 'error', branch }
      const path = local + '...' + revision
      const raw = await this.metadata(GITHUB_API + '/compare/' + path + '?per_page=1', signal)
      if (raw === undefined) return { state: 'uncomparable', branch }
      const data = record(raw)
      const comparison = data?.status
      const aheadBy = data?.ahead_by
      if (!['ahead', 'behind', 'identical', 'diverged'].includes(String(comparison))
        || typeof aheadBy !== 'number' || !Number.isSafeInteger(aheadBy) || aheadBy < 0) return { state: 'error', branch }
      return {
        state: 'ok', branch, revision, aheadBy,
        comparison: comparison as RepositoryCheck['comparison'],
        url: REPOSITORY_URL + '/compare/' + path,
      }
    } catch { return { state: 'error' } }
  }
}
