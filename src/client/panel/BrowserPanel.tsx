/**
 * The browser panel: tab strip, toolbar (back/forward/reload/home/external),
 * address bar, and the tab content area. Inactive tab frames stay mounted
 * (stateful) but hidden; iframes lazy-load on first activation so a restored
 * tab set does not fire every network request at once.
 * @module dsh-browser/client/panel/BrowserPanel
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { normalizeAddress, displayLabel, isDesktopRendererUrl, toProxyUrl, tryParseHttp } from '../../core/url.ts'
import type { ReviewComment, ReviewScreenshot } from '../../core/review.ts'
import { captureReviewScreenshot, createReviewComment, deleteReviewComment, fetchPreviewSession, listReviewComments } from '../api.ts'
import { START_URL, type BrowserTab, type TabsStore } from '../store.ts'
import type { BrowserPanelDeps } from '../mount.tsx'
import { ReviewPanel, type PickedReviewTarget } from './ReviewPanel.tsx'
import { ReviewOverlay } from './ReviewOverlay.tsx'
import { EditorPanel, type EditorTarget } from './EditorPanel.tsx'
import { StartPage } from './StartPage.tsx'
import css from './panel.module.css'

interface BrowserPanelProps {
  store: TabsStore
  deps: BrowserPanelDeps
}

function workspaceFilePath(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.href)
    if (url.origin !== window.location.origin || url.pathname !== '/api/dsh-browser/file') return undefined
    return url.searchParams.get('path') ?? undefined
  } catch {
    return undefined
  }
}

function isWorkspaceFileUrl(value: string): boolean {
  return workspaceFilePath(value) !== undefined
}

function isWorkspaceHtmlUrl(value: string): boolean {
  const path = workspaceFilePath(value)?.toLowerCase() ?? ''
  return path.endsWith('.html') || path.endsWith('.htm')
}

function createPreviewToken(): string {
  try {
    return crypto.randomUUID().replaceAll('-', '')
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}reviewtoken`
  }
}

function captureSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedString(value: unknown, max: number, empty = true): string | undefined {
  if (typeof value !== 'string' || value.length > max || (!empty && value.trim() === '')) return undefined
  return value
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function liveReviewPick(value: unknown): PickedReviewTarget | undefined {
  const message = record(value)
  const rawTarget = record(message?.target)
  const rawRect = record(rawTarget?.rect)
  const rawContext = record(message?.context)
  if (rawTarget === undefined || rawRect === undefined || rawContext === undefined) return undefined
  const kind = rawTarget.kind
  const x = finite(rawRect.x)
  const y = finite(rawRect.y)
  const width = finite(rawRect.width)
  const height = finite(rawRect.height)
  const viewportWidth = finite(rawContext.viewportWidth)
  const viewportHeight = finite(rawContext.viewportHeight)
  const devicePixelRatio = finite(rawContext.devicePixelRatio)
  const selector = boundedString(rawTarget.selector, 4_096)
  const textQuote = boundedString(rawTarget.textQuote, 2_000)
  const tagName = boundedString(rawTarget.tagName, 128, false)
  const outerHTML = boundedString(rawTarget.outerHTML, 16_000)
  if ((kind !== 'element' && kind !== 'region') || x === undefined || y === undefined
    || width === undefined || height === undefined || width <= 0 || height <= 0
    || viewportWidth === undefined || viewportHeight === undefined || viewportWidth <= 0 || viewportHeight <= 0
    || devicePixelRatio === undefined || devicePixelRatio <= 0
    || selector === undefined || textQuote === undefined || tagName === undefined || outerHTML === undefined) return undefined
  const rawAttributes = record(rawTarget.attributes)
  if (rawAttributes === undefined || Object.keys(rawAttributes).length > 64) return undefined
  const attributes: Record<string, string> = {}
  for (const [key, raw] of Object.entries(rawAttributes)) {
    const attribute = boundedString(raw, 1_000)
    if (key.length > 256 || attribute === undefined) return undefined
    attributes[key] = attribute
  }
  const rawSource = record(rawTarget.source)
  const sourceFile = rawSource === undefined ? undefined : boundedString(rawSource.file, 4_096, false)
  if (rawSource !== undefined && sourceFile === undefined) return undefined
  const optionalNumber = (field: string): number | undefined => finite(rawContext[field])
  return {
    target: {
      kind,
      source: sourceFile === undefined
        ? undefined
        : {
            file: sourceFile,
            line: positiveInteger(rawSource?.line),
            column: positiveInteger(rawSource?.column),
          },
      selector,
      textQuote,
      tagName,
      attributes,
      outerHTML,
      rect: { x, y, width, height },
    },
    context: {
      viewportWidth,
      viewportHeight,
      devicePixelRatio,
      scrollX: optionalNumber('scrollX'),
      scrollY: optionalNumber('scrollY'),
      documentWidth: optionalNumber('documentWidth'),
      documentHeight: optionalNumber('documentHeight'),
      pageRevision: boundedString(rawContext.pageRevision, 512),
    },
  }
}

function liveReviewScroll(value: unknown): { x: number, y: number } | undefined {
  const context = record(record(value)?.context)
  const x = finite(context?.scrollX)
  const y = finite(context?.scrollY)
  return x === undefined || y === undefined ? undefined : { x, y }
}

export function BrowserPanel({ store, deps }: BrowserPanelProps): JSX.Element {
  const subscribe = useMemo(() => store.subscribe.bind(store), [store])
  const state = useSyncExternalStore(subscribe, () => store.getSnapshot())
  const t = deps.t
  const desktopRenderer = useMemo(() => isDesktopRendererUrl(window.location.href), [])
  const [draft, setDraft] = useState('')
  const seen = useRef(new Set<string>())
  const content = useRef<HTMLDivElement>(null)
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const previewTokens = useRef(new Map<string, string>())
  const reviewScreenshots = useRef(new Map<string, ReviewScreenshot>())
  const captureEpoch = useRef(0)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewMode, setReviewMode] = useState(false)
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([])
  const [picked, setPicked] = useState<PickedReviewTarget>()
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState<string>()
  const [reviewNotice, setReviewNotice] = useState<string>()
  const [reviewCapture, setReviewCapture] = useState<ReviewScreenshot>()
  const [reviewCapturing, setReviewCapturing] = useState(false)
  const [reviewScroll, setReviewScroll] = useState<{ x: number, y: number }>()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorTarget, setEditorTarget] = useState<EditorTarget>()
  const [editorDirty, setEditorDirty] = useState(false)
  const [previewBaseUrl, setPreviewBaseUrl] = useState<string | undefined>(desktopRenderer ? undefined : '')
  const [previewCarrierFailed, setPreviewCarrierFailed] = useState(false)

  const active = state.tabs.find(tab => tab.id === state.activeId)
  const draftReviewComments = useMemo(
    () => reviewComments.filter(comment => comment.status === 'draft'),
    [reviewComments],
  )

  const tokenFor = (tabId: string): string => {
    let token = previewTokens.current.get(tabId)
    if (token === undefined) {
      token = createPreviewToken()
      previewTokens.current.set(tabId, token)
    }
    return token
  }

  const postReviewMode = (tabId: string, enabled: boolean): void => {
    const frame = frames.current.get(tabId)
    frame?.contentWindow?.postMessage({
      source: 'dsh-browser-parent',
      kind: 'review-mode',
      reviewToken: tokenFor(tabId),
      enabled,
    }, '*')
  }

  const refreshReviews = async (): Promise<void> => {
    if (state.root === '') {
      setReviewComments([])
      return
    }
    try {
      setReviewComments(await listReviewComments(state.root))
      setReviewError(undefined)
    } catch {
      setReviewError(t('review.loadFailed'))
    }
  }

  useEffect(() => {
    if (active !== undefined) seen.current.add(active.id)
    setDraft(active !== undefined && active.url !== START_URL ? active.url : '')
  }, [active?.id, active?.url])

  useEffect(() => {
    if (!desktopRenderer) return
    let current = true
    setPreviewCarrierFailed(false)
    void fetchPreviewSession().then(
      (session) => {
        if (current) setPreviewBaseUrl(session.baseUrl)
      },
      () => {
        if (current) setPreviewCarrierFailed(true)
      },
    )
    return () => { current = false }
  }, [desktopRenderer])

  useEffect(() => {
    captureEpoch.current += 1
    setPicked(undefined)
    setReviewMode(false)
    setReviewCapture(undefined)
    setReviewCapturing(false)
    setReviewNotice(undefined)
    setReviewScroll(undefined)
  }, [active?.id, active?.url])

  useEffect(() => {
    if (active === undefined || !isWorkspaceHtmlUrl(active.url)) return
    postReviewMode(active.id, reviewOpen && reviewMode)
  }, [active?.id, active?.url, reviewMode, reviewOpen])

  useEffect(() => {
    if (reviewOpen) void refreshReviews()
  }, [reviewOpen, state.root])

  // Links clicked inside a proxied iframe post their URL here instead of
  // opening the system browser. _blank / window.open opens a new tab;
  // ordinary links navigate the active tab.
  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const data = event.data
      if (data === null || typeof data !== 'object') return
      if (data.source !== 'dsh-browser') return
      if (data.kind === 'review-pick' || data.kind === 'review-ready' || data.kind === 'review-scroll') {
        if (active === undefined || !isWorkspaceHtmlUrl(active.url)) return
        const frame = frames.current.get(active.id)
        if (event.source !== frame?.contentWindow || data.reviewToken !== tokenFor(active.id)) return
        const scroll = liveReviewScroll(data)
        if (scroll !== undefined) setReviewScroll(scroll)
        if (data.kind === 'review-pick' && reviewMode) {
          const value = liveReviewPick(data)
          if (value !== undefined) {
            setPicked(value)
            setReviewMode(false)
          }
        }
        return
      }
      const rawUrl = typeof data.url === 'string' ? data.url : ''
      const url = tryParseHttp(rawUrl)
      if (url === null) return
      if (data.kind === 'open') {
        store.openTab(url)
      } else if (data.kind === 'navigate') {
        const current = store.activeTab()
        if (current !== undefined) store.navigate(current.id, url)
        else store.openTab(url)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [active?.id, active?.url, reviewMode, store])

  const addReview = async (text: string): Promise<boolean> => {
    if (picked === undefined || active === undefined || active.url === START_URL || state.root === '') return false
    setReviewBusy(true)
    setReviewError(undefined)
    try {
      await createReviewComment({
        workspaceRoot: state.root,
        url: active.url,
        tabId: active.id,
        text,
        target: picked.target,
        context: picked.context,
      })
      setPicked(undefined)
      await refreshReviews()
      setReviewMode(true)
      return true
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : t('review.loadFailed'))
      return false
    } finally {
      setReviewBusy(false)
    }
  }

  const removeReview = async (comment: ReviewComment): Promise<void> => {
    if (comment.status !== 'draft' || state.root === '') return
    if (!window.confirm(t('review.confirmDelete'))) return
    setReviewBusy(true)
    setReviewError(undefined)
    try {
      await deleteReviewComment(state.root, comment.id)
      setReviewComments(current => current.filter(item => item.id !== comment.id))
    } catch {
      setReviewError(t('review.deleteFailed'))
    } finally {
      setReviewBusy(false)
    }
  }

  const submitReviews = async (ids: string[]): Promise<void> => {
    if (state.root === '' || ids.length === 0) return
    const copy = t('review.confirmSend').replace('{count}', String(ids.length))
    if (!window.confirm(copy)) return
    setReviewBusy(true)
    setReviewError(undefined)
    try {
      const selected = ids
        .map(id => reviewComments.find(comment => comment.id === id))
        .filter((comment): comment is ReviewComment => comment !== undefined)
      const screenshots: ReviewScreenshot[] = []
      const screenshotUrls = new Set<string>()
      let captureUnavailable = false
      for (const comment of selected) {
        if (screenshotUrls.has(comment.url)) continue
        screenshotUrls.add(comment.url)
        let screenshot = reviewScreenshots.current.get(comment.url)
        if (screenshot === undefined) {
          try {
            screenshot = await captureReviewScreenshot(
              state.root,
              comment.url,
              captureSize(comment.context.viewportWidth, 320, 1_920),
              captureSize(comment.context.viewportHeight, 240, 1_080),
            )
            reviewScreenshots.current.set(comment.url, screenshot)
          } catch {
            captureUnavailable = true
            continue
          }
        }
        screenshots.push({
          ...screenshot,
          name: `dsh-browser-review-${screenshots.length + 1}.png`,
        })
      }
      if (captureUnavailable) setReviewNotice(t('review.captureUnavailable'))
      await deps.requestAgentReview(state.root, ids, screenshots)
      await refreshReviews()
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : t('review.noSession'))
    } finally {
      setReviewBusy(false)
    }
  }

  const startReviewPicking = async (): Promise<void> => {
    if (active === undefined || active.url === START_URL || state.root === '' || content.current === null) return
    if (isWorkspaceHtmlUrl(active.url)) {
      captureEpoch.current += 1
      setReviewCapturing(false)
      setReviewError(undefined)
      setReviewNotice(undefined)
      setReviewCapture(undefined)
      setPicked(undefined)
      setReviewMode(true)
      return
    }
    if (reviewCapture?.url === active.url) {
      setPicked(undefined)
      setReviewNotice(undefined)
      setReviewMode(true)
      return
    }
    const epoch = ++captureEpoch.current
    const bounds = content.current.getBoundingClientRect()
    setReviewCapturing(true)
    setReviewError(undefined)
    setReviewNotice(undefined)
    setPicked(undefined)
    setReviewMode(false)
    try {
      const screenshot = await captureReviewScreenshot(
        state.root,
        active.url,
        captureSize(bounds.width, 320, 1_920),
        captureSize(bounds.height, 240, 1_080),
      )
      if (epoch !== captureEpoch.current) return
      reviewScreenshots.current.set(active.url, screenshot)
      setReviewCapture(screenshot)
      setReviewMode(true)
    } catch {
      if (epoch === captureEpoch.current) {
        setReviewCapture(undefined)
        setReviewNotice(t('review.captureUnavailable'))
        setReviewMode(true)
      }
    } finally {
      if (epoch === captureEpoch.current) setReviewCapturing(false)
    }
  }

  const closeEditor = (): boolean => {
    if (editorDirty && !window.confirm(t('editor.discardConfirm'))) return false
    setEditorOpen(false)
    setEditorTarget(undefined)
    setEditorDirty(false)
    return true
  }

  const submitAddress = (): void => {
    if (active === undefined) return
    const url = normalizeAddress(draft)
    if (url === null) return
    store.navigate(active.id, url)
  }

  const label = (tab: BrowserTab): string => {
    if (tab.url === START_URL) return tab.label !== '' ? tab.label : t('start.title')
    return tab.label !== '' ? tab.label : displayLabel(tab.url)
  }

  return (
    <div className={css.panel}>
      <div className={css.tabStrip} role="tablist">
        {state.tabs.map(tab => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === state.activeId}
            className={tab.id === state.activeId ? css.tab + ' ' + css.tabActive : css.tab}
            data-active={tab.id === state.activeId ? 'true' : undefined}
            onClick={() => { store.activate(tab.id) }}
            title={tab.url === START_URL ? undefined : tab.url}
          >
            <span className={css.tabLabel}>{label(tab)}</span>
            <button
              type="button"
              className={css.tabClose}
              aria-label={t('tabs.close')}
              title={t('tabs.close')}
              onClick={(event) => {
                event.stopPropagation()
                store.closeTab(tab.id)
              }}
            >
              <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>
            </button>
          </div>
        ))}
        <button
          type="button"
          className={css.newTab}
          aria-label={t('tabs.new')}
          title={t('tabs.new')}
          onClick={() => { store.newTab() }}
        >
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M6 2v8M2 6h8"/></svg>
        </button>
      </div>

      <div className={css.toolbar}>
        <button
          type="button"
          className={css.toolButton}
          disabled={active === undefined || !store.canBack(active.id)}
          aria-label={t('toolbar.back')}
          title={t('toolbar.back')}
          onClick={() => { if (active !== undefined) store.back(active.id) }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3L5.5 8l4.5 5"/></svg>
        </button>
        <button
          type="button"
          className={css.toolButton}
          disabled={active === undefined || !store.canForward(active.id)}
          aria-label={t('toolbar.forward')}
          title={t('toolbar.forward')}
          onClick={() => { if (active !== undefined) store.forward(active.id) }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3l4.5 5L6 13"/></svg>
        </button>
        <button
          type="button"
          className={css.toolButton}
          disabled={active === undefined || active.url === START_URL}
          aria-label={t('toolbar.reload')}
          title={t('toolbar.reload')}
          onClick={() => { if (active !== undefined) store.reload(active.id) }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5V5h-2.5"/></svg>
        </button>
        <button
          type="button"
          className={css.toolButton}
          aria-label={t('toolbar.home')}
          title={t('toolbar.home')}
          onClick={() => {
            if (active !== undefined) {
              const home = normalizeAddress(deps.defaultHome()) ?? 'https://www.bing.com'
              store.navigate(active.id, home)
            }
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8L8 3l5.5 5"/><path d="M4.5 6.8V13h7V6.8"/></svg>
        </button>
        <input
          className={css.address}
          type="text"
          spellCheck={false}
          value={draft}
          placeholder={t('address.placeholder')}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submitAddress()
            }
          }}
        />
        <button
          type="button"
          className={css.toolButton}
          disabled={active === undefined || active.url === START_URL}
          aria-label={t('toolbar.openExternal')}
          title={t('toolbar.openExternal')}
          onClick={() => {
            if (active !== undefined && active.url !== START_URL) {
              window.open(active.url, '_blank', 'noopener')
            }
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.5 9.5L13 3"/><path d="M9 3h4v4"/><path d="M12 9v3.5H3.5V4H8"/></svg>
        </button>
        <button
          type="button"
          className={reviewOpen ? `${css.toolButton} ${css.toolButtonActive}` : css.toolButton}
          disabled={active === undefined || active.url === START_URL
            || (isWorkspaceFileUrl(active.url) && !isWorkspaceHtmlUrl(active.url)) || state.root === ''}
          aria-label={t('review.open')}
          title={t('review.open')}
          onClick={() => {
            if (editorOpen && !closeEditor()) return
            setReviewOpen(value => !value)
            setReviewMode(false)
            setPicked(undefined)
            setReviewCapture(undefined)
            setReviewNotice(undefined)
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3.5h10v7H7l-3.5 2.5v-2.5H3z"/><path d="M5.5 6h5M5.5 8h3"/></svg>
        </button>
        <button
          type="button"
          className={editorOpen ? `${css.toolButton} ${css.toolButtonActive}` : css.toolButton}
          disabled={state.root === ''}
          aria-label={t('editor.open')}
          title={t('editor.open')}
          onClick={() => {
            if (editorOpen) {
              closeEditor()
              return
            }
            setEditorOpen(true)
            setReviewOpen(false)
            setReviewMode(false)
            setPicked(undefined)
            setReviewCapture(undefined)
            setEditorTarget(undefined)
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v9h-11z"/><path d="M5.5 6L7 8 5.5 10M8.5 10h2"/></svg>
        </button>
      </div>

      <div className={css.workspaceBody}>
        <div ref={content} className={css.content}>
          {state.tabs.map(tab => {
            const isActive = tab.id === state.activeId
            const isStart = tab.url === START_URL
            const mounted = isActive || seen.current.has(tab.id)
            const previewToken = tokenFor(tab.id)
            return (
              <div
                key={tab.id}
                className={css.tabPane}
                data-visible={isActive ? 'true' : undefined}
              >
              {isStart ? (
                <StartPage root={state.root} t={t} onNavigate={(url) => { store.navigate(tab.id, url) }} onOpenFile={(url) => { store.openTab(url) }} />
              ) : mounted && previewBaseUrl === undefined ? (
                <div className={css.frameStatus} role="status">
                  {previewCarrierFailed ? t('preview.desktopFailed') : t('preview.desktopLoading')}
                </div>
              ) : mounted ? (
                <iframe
                  key={`${tab.id}:${tab.nonce}`}
                  ref={(node) => {
                    if (node === null) frames.current.delete(tab.id)
                    else frames.current.set(tab.id, node)
                  }}
                  className={css.frame}
                  src={toProxyUrl(tab.url, previewToken, previewBaseUrl)}
                  title={label(tab)}
                  sandbox={isWorkspaceFileUrl(tab.url)
                    ? (isWorkspaceHtmlUrl(tab.url) ? 'allow-scripts' : '')
                    : 'allow-scripts allow-forms'}
                  allow="clipboard-write; fullscreen"
                  referrerPolicy="no-referrer"
                  onLoad={() => {
                    if (isActive && isWorkspaceHtmlUrl(tab.url)) postReviewMode(tab.id, reviewOpen && reviewMode)
                  }}
                />
              ) : null}
              {reviewOpen && isActive && !isStart ? (
                <ReviewOverlay
                  picking={reviewMode && !isWorkspaceHtmlUrl(tab.url)}
                  picked={picked}
                  markers={draftReviewComments
                    .map((comment, index) => ({ comment, number: index + 1 }))
                    .filter(marker => marker.comment.url === tab.url)}
                  nextNumber={draftReviewComments.length + 1}
                  label={t('review.canvas')}
                  commentTitle={t('review.commentTitle').replace('{number}', String(draftReviewComments.length + 1))}
                  placeholder={t('review.placeholder')}
                  saveLabel={t('review.add')}
                  cancelLabel={t('review.cancelComment')}
                  busy={reviewBusy}
                  scrollPosition={reviewScroll}
                  screenshot={reviewCapture?.url === tab.url
                    ? `data:${reviewCapture.mediaType};base64,${reviewCapture.data}`
                    : undefined}
                  onPick={(value) => { setPicked(value); setReviewMode(false) }}
                  onCreate={addReview}
                  onCancelPicked={() => { setPicked(undefined); setReviewMode(true) }}
                />
              ) : null}
              </div>
            )
          })}
        </div>
        {reviewOpen ? (
          <ReviewPanel
            comments={draftReviewComments}
            picking={reviewMode}
            capturing={reviewCapturing}
            busy={reviewBusy || reviewCapturing}
            error={reviewError}
            notice={reviewNotice}
            t={t}
            onStartPicking={() => { void startReviewPicking() }}
            onCancelPicking={() => {
              captureEpoch.current += 1
              setReviewMode(false)
              setPicked(undefined)
              setReviewCapturing(false)
              setReviewCapture(undefined)
            }}
            onDelete={removeReview}
            onSubmit={submitReviews}
            onRefresh={() => { void refreshReviews() }}
            onOpenSource={(file, sourceLine) => {
              setReviewOpen(false)
              setReviewMode(false)
              setReviewCapture(undefined)
              setEditorTarget({ path: file, line: sourceLine })
              setEditorOpen(true)
            }}
            onClose={() => {
              captureEpoch.current += 1
              setReviewOpen(false)
              setReviewMode(false)
              setPicked(undefined)
              setReviewCapture(undefined)
              setReviewNotice(undefined)
            }}
          />
        ) : null}
        {editorOpen ? (
          <EditorPanel
            root={state.root}
            target={editorTarget}
            t={t}
            onDirtyChange={setEditorDirty}
            onClose={() => { closeEditor() }}
          />
        ) : null}
      </div>
    </div>
  )
}
