/** A separate modal root: update details never navigate or remount the browser. */
import { Component, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  availableUpdate, isValidVersion, waitingForNpm, REPOSITORY_URL, UPDATE_PACKAGE,
  type UpdateSnapshot, type VersionCheck,
} from '../core/updates.ts'
import type { UpdatesStore } from './updates.ts'
import { tt } from './translate.ts'
import css from './updates.module.css'

function statusKey(value: UpdateSnapshot): string {
  if (availableUpdate(value)) return 'updates.available'
  if (value.installation === 'source' && value.followRepository) {
    const repo = value.repository
    if (repo.state === 'error') return 'updates.failed'
    if (repo.state === 'unchecked') return 'updates.unchecked'
    if (repo.state === 'uncomparable' || repo.comparison === 'diverged') return 'updates.uncomparable'
    return repo.comparison === 'behind' ? 'updates.localAhead' : 'updates.noNewVersion'
  }
  if (!isValidVersion(value.currentVersion)) return 'updates.uncomparable'
  const checks = value.installation === 'npm' ? [value.npm]
    : value.installation === 'source' ? [value.github] : [value.npm, value.github]
  if (checks.some(result => result.state === 'error')) return 'updates.failed'
  if (checks.some(result => result.state === 'unchecked')) return 'updates.unchecked'
  return checks.some(result => result.state === 'ok') ? 'updates.noNewVersion' : 'updates.empty'
}

function versionLabel(value: VersionCheck): string {
  return value.state === 'ok' && value.release ? value.release.version : tt('updates.' + value.state)
}

export function UpdateDetails({ store, close }: { store: UpdatesStore; close: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const value = state.snapshot
  const offer = value && availableUpdate(value)
  const ignored = offer?.key === state.ignoredKey
  const checking = state.busy || value?.checking
  const message = checking ? 'updates.checking' : state.unavailable ? 'updates.failed'
    : value ? statusKey(value) : 'updates.unchecked'
  const source = value?.installation ?? 'unknown'
  const notes = offer?.notes ?? (offer && value?.github.release?.version === offer.version ? value.github.release.notes : undefined)
  const refresh = () => { void store.refresh() }
  return (
    <>
      <header className={css.header}>
        <div>
          <h2 id="dsh-browser-update-title">{tt('updates.title')}</h2>
          <p>{UPDATE_PACKAGE}</p>
        </div>
        <button type="button" onClick={close} aria-label={tt('updates.close')} className={css.close}>×</button>
      </header>
      <section className={css.body}>
        <div className={css.summary} data-available={Boolean(offer && !state.unavailable)}>
          <strong role="status">{tt(message)}</strong>
          {value && <p>{tt('updates.current')}: {value.currentVersion}
            {value.currentRevision && <code> ({value.currentRevision.slice(0, 7)})</code>}
          </p>}
          {offer && <p>{tt('updates.latest')}: <b>{offer.version}</b> · {offer.source === 'npm' ? 'npm' : 'GitHub'}
            {ignored && <span> · {tt('updates.ignored')}</span>}
          </p>}
        </div>
        {value && (
          <dl className={css.metadata}>
            <dt>{tt('updates.installation')}</dt><dd>{tt('updates.source.' + source)}</dd>
            <dt>{tt('updates.channel')}</dt><dd>{tt(value.followRepository && source === 'source' ? 'updates.channel.repository' : 'updates.channel.stable')}</dd>
            <dt>npm latest</dt><dd>{versionLabel(value.npm)}</dd>
            <dt>GitHub Release</dt><dd>{versionLabel(value.github)}</dd>
            {value.followRepository && source === 'source' && <>
              <dt>{tt('updates.branch')}</dt><dd>{value.repository.branch ?? '-'} · {value.repository.revision?.slice(0, 7) ?? '-'}</dd>
            </>}
          </dl>
        )}
        {value && waitingForNpm(value) && <p className={css.notice}>{tt('updates.waitingNpm')}</p>}
        {message === 'updates.uncomparable' && <p className={css.notice}>{tt('updates.uncomparableHint')}</p>}
        {source === 'unknown' && <p className={css.notice}>{tt('updates.unknownHint')}</p>}
        {notes && <details className={css.notes}>
          <summary>{tt('updates.notes')}</summary>
          <pre>{notes}</pre>
        </details>}
        {offer && <div className={css.guidance}>
          <h3>{tt('updates.howToUpdate')}</h3>
          <p>{tt(source === 'npm' ? 'updates.guide.npm' : source === 'source' ? 'updates.guide.source' : 'updates.guide.unknown')}</p>
          <a href={offer.url} target="_blank" rel="noopener noreferrer">{tt('updates.viewRelease')}</a>
        </div>}
        <p className={css.hint}>{tt(value?.autoCheck ? 'updates.automaticHint' : 'updates.manualHint')}</p>
        {value?.checkedAt !== undefined && <p className={css.hint}>{tt('updates.lastChecked')}: {new Date(value.checkedAt).toLocaleString()}</p>}
        <p className={css.hint}>{tt('updates.notifyOnly')}</p>
      </section>
      <footer className={css.footer}>
        <a href={REPOSITORY_URL + '#install'} target="_blank" rel="noopener noreferrer">{tt('updates.help')}</a>
        <div className={css.actions}>
          {offer && <button type="button" onClick={ignored ? store.restoreIgnored : store.ignoreCurrent}>
            {tt(ignored ? 'updates.restore' : 'updates.ignore')}
          </button>}
          <button type="button" onClick={refresh} disabled={checking}>{tt(checking ? 'updates.checking' : 'updates.check')}</button>
        </div>
      </footer>
    </>
  )
}

class UpdateErrorBoundary extends Component<{ children: ReactNode; close: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { console.warn('[dsh-browser] update details failed:', error) }
  render() {
    return this.state.failed ? <div className={css.body}>
      <p role="alert">{tt('updates.failed')}</p>
      <button type="button" onClick={this.props.close}>{tt('updates.close')}</button>
    </div> : this.props.children
  }
}

export function mountUpdateDialog(store: UpdatesStore): { open: () => void; dispose: () => void } {
  const dialog = document.createElement('dialog')
  dialog.dataset.dshBrowserUpdateDialog = ''
  dialog.className = css.dialog
  dialog.setAttribute('aria-labelledby', 'dsh-browser-update-title')
  document.body.appendChild(dialog)
  const root = createRoot(dialog)
  const close = () => { dialog.close() }
  root.render(<UpdateErrorBoundary close={close}><UpdateDetails store={store} close={close} /></UpdateErrorBoundary>)
  return {
    open: () => {
      try {
        if (!dialog.open) dialog.showModal()
        void store.read()
      } catch (error) { console.warn('[dsh-browser] update dialog unavailable:', error) }
    },
    dispose: () => {
      if (dialog.open) dialog.close()
      root.unmount()
      dialog.remove()
    },
  }
}
