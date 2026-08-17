/**
 * The new-tab start page: a search/address box, quick links, and the current
 * workspace file listing (folders navigate, files open in the panel through
 * the host's gated file route).
 * @module dsh-browser/client/panel/StartPage
 */

import { useEffect, useState } from 'react'
import { normalizeAddress } from '../../core/url.ts'
import type { WorkspaceListing } from '../../core/types.ts'
import { fileUrl, listWorkspace } from '../api.ts'
import css from './panel.module.css'

interface StartPageProps {
  root: string
  t: (key: string) => string
  onNavigate: (url: string) => void
  onOpenFile: (url: string) => void
}

/** Static quick links (scheme-less domain bookmarks). */
const QUICK_LINKS: Array<{ label: string; url: string }> = [
  { label: 'Bing', url: 'https://www.bing.com' },
  { label: 'GitHub', url: 'https://github.com' },
  { label: 'MDN', url: 'https://developer.mozilla.org' },
  { label: 'Wikipedia', url: 'https://www.wikipedia.org' },
  { label: 'npm', url: 'https://www.npmjs.com' },
]

export function StartPage({ root, t, onNavigate, onOpenFile }: StartPageProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<WorkspaceListing | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setListing(null)
    setFailed(false)
    if (root === '') return
    listWorkspace(root, path)
      .then(value => { if (!cancelled) setListing(value) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [root, path])

  const submit = (): void => {
    const url = normalizeAddress(query)
    if (url !== null) onNavigate(url)
  }

  const join = (name: string): string => (path === '' ? name : `${path}/${name}`)

  const base = root.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? 'workspace'

  return (
    <div className={css.start}>
      <h2 className={css.startTitle}>{t('start.title')}</h2>

      <div className={css.searchRow}>
        <input
          className={css.search}
          type="text"
          spellCheck={false}
          value={query}
          placeholder={t('start.searchPlaceholder')}
          onChange={(event) => { setQuery(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button type="button" className={css.goButton} onClick={submit}>{t('start.go')}</button>
      </div>

      <section className={css.startSection}>
        <h3 className={css.startHeading}>{t('start.quickLinks')}</h3>
        <div className={css.quickLinks}>
          {QUICK_LINKS.map(link => (
            <button
              key={link.url}
              type="button"
              className={css.quickLink}
              onClick={() => { onNavigate(link.url) }}
            >
              {link.label}
            </button>
          ))}
        </div>
      </section>

      <section className={css.startSection}>
        <h3 className={css.startHeading}>{t('start.workspace')}</h3>
        {root === '' ? (
          <p className={css.hint}>{t('start.noSession')}</p>
        ) : failed ? (
          <p className={css.hint}>{t('start.loadFailed')}</p>
        ) : listing === null ? (
          <p className={css.hint}>{base}</p>
        ) : (
          <>
            <div className={css.crumbs}>
              <button type="button" className={css.crumb} onClick={() => { setPath('') }}>{base}</button>
              {path.split('/').filter(Boolean).map((segment, index, parts) => (
                <span key={index} className={css.crumbRow}>
                  <span className={css.crumbSep}>/</span>
                  <button
                    type="button"
                    className={css.crumb}
                    onClick={() => { setPath(parts.slice(0, index + 1).join('/')) }}
                  >
                    {segment}
                  </button>
                </span>
              ))}
              {path !== '' ? (
                <button
                  type="button"
                  className={css.crumbUp}
                  title={t('start.up')}
                  onClick={() => { setPath(path.split('/').slice(0, -1).join('/')) }}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>
                </button>
              ) : null}
            </div>
            {listing.entries.length === 0 ? (
              <p className={css.hint}>{t('start.emptyWorkspace')}</p>
            ) : (
              <ul className={css.entryList}>
                {listing.entries.map(entry => (
                  <li key={entry.name}>
                    <button
                      type="button"
                      className={css.entryRow}
                      data-kind={entry.kind}
                      onClick={() => {
                        if (entry.kind === 'dir') setPath(join(entry.name))
                        else if (entry.kind === 'file') onOpenFile(fileUrl(root, join(entry.name)))
                      }}
                    >
                      <span className={css.entryIcon}>{entry.kind === 'dir' ? folderIcon() : fileIcon()}</span>
                      <span className={css.entryName}>{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  )
}

function folderIcon(): JSX.Element {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.8h5A1.5 1.5 0 0 1 14 6.3v5.2a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>
}

function fileIcon(): JSX.Element {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5h5.5L13 6v7.5H4z"/><path d="M9.5 2.5V6H13"/></svg>
}
