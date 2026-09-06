import { NPM_URL, REPOSITORY_URL, type UpdateSnapshot } from '../../src/core/updates.ts'

export function updateSnapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    currentVersion: '0.2.0',
    installation: 'npm',
    autoCheck: true,
    followRepository: false,
    checking: false,
    checkedAt: 1_000,
    npm: { state: 'ok', release: { version: '0.3.0', url: NPM_URL + '/v/0.3.0' } },
    github: { state: 'ok', release: { version: '0.3.0', url: REPOSITORY_URL + '/releases/tag/v0.3.0' } },
    repository: { state: 'unchecked' },
    ...overrides,
  }
}
