/** Lightweight workspace editor: directory browser, CodeMirror, and safe save. */

import { useEffect, useState } from 'react'
import { isPreviewableImage, type SourceDocument } from '../../core/editor.ts'
import type { WorkspaceListing } from '../../core/types.ts'
import { fileUrl, listWorkspace, readSourceDocument, writeSourceDocument } from '../api.ts'
import { CodeEditor } from './CodeEditor.tsx'
import css from './panel.module.css'

export interface EditorTarget {
  path: string
  line: number | undefined
}

interface ImagePreview {
  root: string
  path: string
}

interface EditorPanelProps {
  root: string
  target: EditorTarget | undefined
  t: (key: string) => string
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
}

export function EditorPanel({ root, target, t, onDirtyChange, onClose }: EditorPanelProps): JSX.Element {
  const [directory, setDirectory] = useState('')
  const [listing, setListing] = useState<WorkspaceListing>()
  const [document, setDocument] = useState<SourceDocument>()
  const [image, setImage] = useState<ImagePreview>()
  const [content, setContent] = useState('')
  const [line, setLine] = useState<number>()
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const openFile = async (path: string, targetLine?: number): Promise<void> => {
    if (dirty && !window.confirm(t('editor.discardConfirm'))) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await readSourceDocument(root, path)
      setDocument(next)
      setImage(undefined)
      setContent(next.content)
      setLine(targetLine)
      setDirty(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('editor.loadFailed'))
    } finally {
      setBusy(false)
    }
  }

  const openImage = (path: string): void => {
    if (dirty && !window.confirm(t('editor.discardConfirm'))) return
    setDocument(undefined)
    setImage({ root, path })
    setContent('')
    setLine(undefined)
    setDirty(false)
    setError(undefined)
  }

  const openPath = (path: string, targetLine?: number): void => {
    if (isPreviewableImage(path)) openImage(path)
    else void openFile(path, targetLine)
  }

  useEffect(() => {
    setListing(undefined)
    if (root === '') return
    let cancelled = false
    listWorkspace(root, directory)
      .then(value => { if (!cancelled) setListing(value) })
      .catch(() => { if (!cancelled) setError(t('editor.loadFailed')) })
    return () => { cancelled = true }
  }, [root, directory])

  useEffect(() => {
    if (target === undefined || target.path === '') return
    const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '')
    const normalizedPath = target.path.replaceAll('\\', '/')
    const relative = normalizedPath.startsWith(`${normalizedRoot}/`)
      ? normalizedPath.slice(normalizedRoot.length + 1)
      : normalizedPath.replace(/^\.\//, '')
    openPath(relative, target.line)
  }, [target?.path, target?.line, root])

  const save = async (): Promise<void> => {
    if (document === undefined || !dirty) return
    setBusy(true)
    setError(undefined)
    try {
      const saved = await writeSourceDocument({
        workspaceRoot: document.root,
        path: document.path,
        content,
        expectedHash: document.hash,
      })
      setDocument(saved)
      setContent(saved.content)
      setDirty(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('editor.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    onClose()
  }

  const join = (name: string): string => directory === '' ? name : `${directory}/${name}`

  return (
    <aside className={css.editorPanel} aria-label={t('editor.title')}>
      <div className={css.editorHeader}>
        <div>
          <h3 className={css.reviewTitle}>{t('editor.title')}</h3>
          <p className={css.reviewSubtitle}>{document?.path ?? image?.path ?? t('editor.subtitle')}</p>
        </div>
        <div className={css.editorHeaderActions}>
          <button type="button" className={css.reviewPrimaryButton} disabled={!dirty || busy} onClick={() => { void save() }}>
            {busy ? t('editor.saving') : t('editor.save')}
          </button>
          <button type="button" className={css.reviewIconButton} onClick={close} aria-label={t('editor.close')}>×</button>
        </div>
      </div>
      <div className={css.editorBody}>
        <nav className={css.editorFiles} aria-label={t('editor.files')}>
          <div className={css.editorPath}>
            <button type="button" onClick={() => { setDirectory('') }}>{root.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? 'workspace'}</button>
            {directory !== '' ? <span>/{directory}</span> : null}
          </div>
          {directory !== '' ? (
            <button type="button" className={css.editorFileRow} onClick={() => { setDirectory(directory.split('/').slice(0, -1).join('/')) }}>..</button>
          ) : null}
          {listing?.entries.map(entry => (
            <button
              key={entry.name}
              type="button"
              className={css.editorFileRow}
              data-kind={entry.kind}
              disabled={entry.kind === 'other'}
              onClick={() => {
                const path = join(entry.name)
                if (entry.kind === 'dir') setDirectory(path)
                else if (entry.kind === 'file') openPath(path)
              }}
            >
              <span>{entry.kind === 'dir' ? 'D' : 'F'}</span>
              <span>{entry.name}</span>
            </button>
          ))}
        </nav>
        <div className={css.editorMain}>
          {error !== undefined ? <p className={css.editorError}>{error}</p> : null}
          {image !== undefined ? (
            <div className={css.editorImagePreview}>
              <img
                className={css.editorImage}
                src={fileUrl(image.root, image.path)}
                alt={t('editor.imageAlt').replace('{name}', image.path)}
                onLoad={() => { setError(undefined) }}
                onError={() => { setError(t('editor.imageLoadFailed')) }}
              />
            </div>
          ) : document === undefined ? (
            <p className={css.editorEmpty}>{busy ? t('editor.loading') : t('editor.selectFile')}</p>
          ) : (
            <CodeEditor
              document={document}
              line={line}
              onChange={(value) => {
                setContent(value)
                setDirty(value !== document.content)
              }}
            />
          )}
        </div>
      </div>
    </aside>
  )
}
