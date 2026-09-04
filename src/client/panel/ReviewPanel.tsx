/** Review drawer: mode controls, comment list, and Agent handoff. */

import type { ReviewComment, ReviewContext, ReviewTarget } from '../../core/review.ts'
import css from './panel.module.css'

export interface PickedReviewTarget {
  target: ReviewTarget
  context: ReviewContext
}

interface ReviewPanelProps {
  comments: ReviewComment[]
  picking: boolean
  capturing: boolean
  busy: boolean
  error: string | undefined
  notice: string | undefined
  t: (key: string) => string
  onStartPicking: () => void
  onCancelPicking: () => void
  onDelete: (comment: ReviewComment) => Promise<void>
  onSubmit: (ids: string[]) => Promise<void>
  onRefresh: () => void
  onOpenSource: (file: string, line: number | undefined) => void
  onClose: () => void
}

export function ReviewPanel(props: ReviewPanelProps): JSX.Element {
  const { comments, picking, busy, error, notice, t } = props
  const drafts = comments.filter(comment => comment.status === 'draft')

  const location = (comment: ReviewComment): string => {
    const target = comment.target
    if (target.kind === 'region') {
      const { x, y, width, height } = target.rect
      return `${t('review.region')} ${Math.round(x)},${Math.round(y)} ${Math.round(width)}×${Math.round(height)}`
    }
    return target.source?.file ?? target.selector ?? target.tagName
  }

  return (
    <aside className={css.reviewPanel} aria-label={t('review.title')}>
      <div className={css.reviewHeader}>
        <div>
          <h3 className={css.reviewTitle}>{t('review.title')}</h3>
          <p className={css.reviewSubtitle}>{t('review.subtitle')}</p>
        </div>
        <button type="button" className={css.reviewIconButton} onClick={props.onClose} aria-label={t('review.close')}>×</button>
      </div>

      <div className={css.reviewActions}>
        <button
          type="button"
          className={picking ? `${css.reviewButton} ${css.reviewButtonActive}` : css.reviewButton}
          disabled={busy}
          onClick={picking ? props.onCancelPicking : props.onStartPicking}
        >
          {props.capturing ? t('review.capturing') : picking ? t('review.cancelPick') : t('review.pick')}
        </button>
        <button type="button" className={css.reviewGhostButton} disabled={busy} onClick={props.onRefresh}>
          {t('review.refresh')}
        </button>
      </div>

      {picking ? <p className={css.reviewHint}>{t('review.pickHint')}</p> : null}
      {notice !== undefined ? <p className={css.reviewNotice}>{notice}</p> : null}
      {error !== undefined ? <p className={css.reviewError}>{error}</p> : null}

      <div className={css.reviewList}>
        {comments.length === 0 ? <p className={css.reviewEmpty}>{t('review.empty')}</p> : comments.map((comment, index) => (
          <article key={comment.id} className={css.reviewComment} data-status={comment.status}>
            <div className={css.reviewCommentHead}>
              <span className={css.reviewIndex}>{index + 1}</span>
              <span className={css.reviewStatus}>{t(`review.status.${comment.status}`)}</span>
            </div>
            <p className={css.reviewCommentText}>{comment.text}</p>
            <code className={css.reviewLocation}>
              {location(comment)}
              {comment.target.source?.line === undefined ? '' : `:${comment.target.source.line}`}
            </code>
            {comment.status === 'draft' ? (
              <button
                type="button"
                className={css.reviewDeleteButton}
                disabled={busy}
                onClick={() => { void props.onDelete(comment) }}
              >
                {t('review.delete')}
              </button>
            ) : null}
            {comment.target.source !== undefined ? (
              <button
                type="button"
                className={css.reviewSourceButton}
                onClick={() => { props.onOpenSource(comment.target.source?.file ?? '', comment.target.source?.line) }}
              >
                {t('review.openSource')}
              </button>
            ) : null}
          </article>
        ))}
      </div>

      <div className={css.reviewFooter}>
        <span>{t('review.draftCount').replace('{count}', String(drafts.length))}</span>
        <button
          type="button"
          className={css.reviewPrimaryButton}
          disabled={busy || drafts.length === 0}
          onClick={() => { void props.onSubmit(drafts.map(comment => comment.id)) }}
        >
          {busy ? t('review.sending') : t('review.send')}
        </button>
      </div>
    </aside>
  )
}
