import { describe, expect, it } from 'vitest'
import { availableUpdate, isNewerStableVersion, isStableVersion, waitingForNpm } from '../src/core/updates.ts'
import { updateSnapshot } from './fixtures/updates.ts'

describe('installation-aware update decisions', () => {
  it.each([
    ['0.10.0', '0.9.9', true],
    ['1.0.0', '0.99.0', true],
    ['v0.2.0', '0.2.0-rc.2', true],
    ['0.2.0+new', '0.2.0+old', false],
    ['0.1.0', '0.2.0', false],
    ['0.3.0-beta.1', '0.2.0', false],
    ['0.3.0', 'unknown', false],
    ['01.3.0', '0.2.0', false],
    ['1.0.0', '1.0.0-01', false],
  ])('compares %s against %s without lexical ordering or downgrades', (candidate, installed, expected) => {
    expect(isNewerStableVersion(candidate, installed)).toBe(expected)
  })

  it('accepts stable tags and rejects prereleases and malformed versions', () => {
    expect(isStableVersion('v2.0.1+build.123')).toBe(true)
    for (const version of ['latest', '2.0', '2.0.1-beta', '2.0.1+', '2.01.0', '2.0.1\n']) {
      expect(isStableVersion(version), version).toBe(false)
    }
  })

  it('waits for npm publication instead of suggesting a GitHub-only install', () => {
    const value = updateSnapshot({ npm: { state: 'ok', release: { version: '0.2.0', url: '' } } })
    expect(availableUpdate(value)).toBeUndefined()
    expect(waitingForNpm(value)).toBe(true)
    expect(availableUpdate({ ...value, installation: 'source' })?.source).toBe('github')
    expect(availableUpdate({ ...value, npm: { state: 'error' } })).toBeUndefined()
    expect(waitingForNpm({ ...value, npm: { state: 'error' } })).toBe(false)
  })

  it('isolates a failing secondary source and chooses the highest version for unknown installs', () => {
    expect(availableUpdate(updateSnapshot({ github: { state: 'error' } }))?.source).toBe('npm')
    const value = updateSnapshot({ installation: 'unknown', github: { state: 'ok', release: { version: '1.0.0', url: '' } } })
    expect(availableUpdate(value)?.version).toBe('1.0.0')
  })

  it.each(['behind', 'identical', 'diverged'] as const)('does not prompt a source build to update a %s branch', comparison => {
    expect(availableUpdate(updateSnapshot({
      installation: 'source', followRepository: true,
      repository: { state: 'ok', comparison, revision: 'b'.repeat(40), url: 'https://github.com/Nono-neko/dsh-browser' },
    }))).toBeUndefined()
  })

  it('uses a commit-specific notification only when the default branch is ahead', () => {
    const value = updateSnapshot({
      installation: 'source', followRepository: true,
      repository: { state: 'ok', comparison: 'ahead', revision: 'b'.repeat(40), url: 'https://github.com/Nono-neko/dsh-browser' },
    })
    expect(availableUpdate(value)?.key).toBe('repository:' + 'b'.repeat(40))
    expect(availableUpdate({ ...value, repository: { state: 'uncomparable' } })).toBeUndefined()
  })
})
