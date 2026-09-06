/** Shared update metadata and installation-aware version decisions. */

export const UPDATE_PACKAGE = '@nono-neko/dsh-browser'
export const UPDATE_REPOSITORY = 'Nono-neko/dsh-browser'
export const REPOSITORY_URL = 'https://github.com/Nono-neko/dsh-browser'
export const NPM_URL = 'https://www.npmjs.com/package/@nono-neko/dsh-browser'
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

export type InstallationSource = 'npm' | 'source' | 'unknown'

export interface PublishedVersion {
  version: string
  url: string
  notes?: string
  publishedAt?: string
}

export interface VersionCheck {
  state: 'unchecked' | 'ok' | 'empty' | 'error'
  release?: PublishedVersion
}

export interface RepositoryCheck {
  state: 'unchecked' | 'ok' | 'uncomparable' | 'error'
  branch?: string
  revision?: string
  aheadBy?: number
  comparison?: 'ahead' | 'behind' | 'identical' | 'diverged'
  url?: string
}

export interface UpdateSnapshot {
  currentVersion: string
  currentRevision?: string
  installation: InstallationSource
  autoCheck: boolean
  followRepository: boolean
  checking: boolean
  checkedAt?: number
  npm: VersionCheck
  github: VersionCheck
  repository: RepositoryCheck
}

export interface UpdateOffer extends PublishedVersion {
  source: 'npm' | 'github' | 'repository'
  key: string
}

/** Only well-formed SemVer values are comparable; metadata has no precedence. */
function parseVersion(value: string): { parts: bigint[]; prerelease: boolean } | undefined {
  if (value.length > 200) return undefined
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  if (match === null) return undefined
  if (match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return undefined
  return { parts: match.slice(1, 4).map(BigInt), prerelease: match[4] !== undefined }
}

export function isStableVersion(value: string): boolean {
  return parseVersion(value)?.prerelease === false
}

export function isValidVersion(value: string): boolean {
  return parseVersion(value) !== undefined
}

/** A same-core stable release supersedes an installed prerelease. */
export function isNewerStableVersion(candidate: string, installed: string): boolean {
  const remote = parseVersion(candidate)
  const local = parseVersion(installed)
  if (remote === undefined || local === undefined || remote.prerelease) return false
  for (let index = 0; index < 3; index++) {
    if (remote.parts[index] !== local.parts[index]) return remote.parts[index] > local.parts[index]
  }
  return local.prerelease
}

/** Do not advertise a GitHub-only release as installable from npm. */
export function availableUpdate(value: UpdateSnapshot): UpdateOffer | undefined {
  if (value.installation === 'source' && value.followRepository) {
    const repo = value.repository
    if (repo.state !== 'ok' || repo.comparison !== 'ahead' || !repo.revision || !repo.url) return undefined
    return { source: 'repository', version: repo.revision.slice(0, 7), url: repo.url, key: 'repository:' + repo.revision }
  }
  const sources = value.installation === 'npm' ? ['npm'] as const
    : value.installation === 'source' ? ['github'] as const : ['npm', 'github'] as const
  let offer: UpdateOffer | undefined
  for (const source of sources) {
    const result = value[source]
    const release = result.state === 'ok' ? result.release : undefined
    if (!release || !isNewerStableVersion(release.version, value.currentVersion)) continue
    if (offer && !isNewerStableVersion(release.version, offer.version)) continue
    offer = { ...release, source, key: source + ':' + release.version }
  }
  return offer
}

export function waitingForNpm(value: UpdateSnapshot): boolean {
  const release = value.github.state === 'ok' ? value.github.release : undefined
  if (value.installation !== 'npm' || !release || !isNewerStableVersion(release.version, value.currentVersion)) return false
  return value.npm.state === 'empty' || (value.npm.state === 'ok' && value.npm.release !== undefined
    && isNewerStableVersion(release.version, value.npm.release.version))
}
