/** Parent-layer page picker, numbered markers, and in-place comment composer. */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { ReviewComment, ReviewContext, ReviewRect, ReviewTarget } from '../../core/review.ts'
import type { PickedReviewTarget } from './ReviewPanel.tsx'
import css from './panel.module.css'

export interface ReviewMarker {
  comment: ReviewComment
  number: number
}

interface ReviewOverlayProps {
  picking: boolean
  picked: PickedReviewTarget | undefined
  markers: ReviewMarker[]
  nextNumber: number
  label: string
  commentTitle: string
  placeholder: string
  saveLabel: string
  cancelLabel: string
  busy: boolean
  scrollPosition?: Point
  screenshot: string | undefined
  onPick: (value: PickedReviewTarget) => void
  onCreate: (text: string) => Promise<boolean>
  onCancelPicked: () => void
}

interface Point {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function localPoint(event: ReactPointerEvent<HTMLDivElement>): Point {
  const bounds = event.currentTarget.getBoundingClientRect()
  return {
    x: clamp(event.clientX - bounds.left, 0, bounds.width),
    y: clamp(event.clientY - bounds.top, 0, bounds.height),
  }
}

function rectFromPoints(start: Point, end: Point): ReviewRect {
  const dragWidth = Math.abs(end.x - start.x)
  const dragHeight = Math.abs(end.y - start.y)
  if (dragWidth >= 4 || dragHeight >= 4) {
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.max(1, dragWidth),
      height: Math.max(1, dragHeight),
    }
  }
  return { x: start.x, y: start.y, width: 1, height: 1 }
}

function viewportRect(rect: ReviewRect, context: ReviewContext, scrollPosition?: Point): ReviewRect {
  if (scrollPosition === undefined || context.scrollX === undefined || context.scrollY === undefined) return rect
  return {
    ...rect,
    x: rect.x + context.scrollX - scrollPosition.x,
    y: rect.y + context.scrollY - scrollPosition.y,
  }
}

function regionStyle(rect: ReviewRect, context: ReviewContext, scrollPosition?: Point): CSSProperties {
  const width = Math.max(1, context.viewportWidth)
  const height = Math.max(1, context.viewportHeight)
  const visible = viewportRect(rect, context, scrollPosition)
  return {
    left: `${(visible.x / width) * 100}%`,
    top: `${(visible.y / height) * 100}%`,
    width: `${(visible.width / width) * 100}%`,
    height: `${(visible.height / height) * 100}%`,
  }
}

function popoverPosition(value: PickedReviewTarget, scrollPosition?: Point): { className: string, style: CSSProperties } {
  const width = Math.max(1, value.context.viewportWidth)
  const height = Math.max(1, value.context.viewportHeight)
  const rect = viewportRect(value.target.rect, value.context, scrollPosition)
  const x = clamp(((rect.x + rect.width / 2) / width) * 100, 0, 100)
  const y = clamp(((rect.y + rect.height / 2) / height) * 100, 0, 100)
  const classes = [css.reviewPopover]
  if (x > 62) classes.push(css.reviewPopoverLeft)
  if (y > 62) classes.push(css.reviewPopoverAbove)
  return {
    className: classes.join(' '),
    style: { left: `${x}%`, top: `${y}%` },
  }
}

function pickedTarget(rect: ReviewRect, viewportWidth: number, viewportHeight: number): PickedReviewTarget {
  const target: ReviewTarget = {
    kind: 'region',
    source: undefined,
    selector: '',
    textQuote: '',
    tagName: 'region',
    attributes: {},
    outerHTML: '',
    rect,
  }
  return {
    target,
    context: {
      viewportWidth,
      viewportHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      pageRevision: undefined,
    },
  }
}

export function ReviewOverlay(props: ReviewOverlayProps): JSX.Element {
  const [start, setStart] = useState<Point>()
  const [current, setCurrent] = useState<Point>()
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!props.picking) {
      setStart(undefined)
      setCurrent(undefined)
    }
  }, [props.picking])

  useEffect(() => {
    if (props.picked === undefined) return
    setText('')
    textarea.current?.focus()
  }, [props.picked])

  const begin = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!props.picking || event.button !== 0) return
    event.preventDefault()
    const point = localPoint(event)
    setStart(point)
    setCurrent(point)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!props.picking || start === undefined) return
    event.preventDefault()
    setCurrent(localPoint(event))
  }

  const finish = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!props.picking || start === undefined) return
    event.preventDefault()
    const end = localPoint(event)
    const bounds = event.currentTarget.getBoundingClientRect()
    props.onPick(pickedTarget(rectFromPoints(start, end), bounds.width, bounds.height))
    setStart(undefined)
    setCurrent(undefined)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const save = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const value = text.trim()
    if (value === '' || props.picked === undefined || props.busy || saving) return
    setSaving(true)
    try {
      if (await props.onCreate(value)) setText('')
    } finally {
      setSaving(false)
    }
  }

  const drawing = start !== undefined && current !== undefined
    ? {
        left: `${Math.min(start.x, current.x)}px`,
        top: `${Math.min(start.y, current.y)}px`,
        width: `${Math.max(1, Math.abs(current.x - start.x))}px`,
        height: `${Math.max(1, Math.abs(current.y - start.y))}px`,
      }
    : undefined
  const popover = props.picked === undefined ? undefined : popoverPosition(props.picked, props.scrollPosition)

  return (
    <div
      className={css.reviewOverlay}
      data-picking={props.picking ? 'true' : undefined}
      data-review-overlay=""
      aria-label={props.label}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={() => { setStart(undefined); setCurrent(undefined) }}
    >
      {props.screenshot !== undefined ? (
        <img className={css.reviewCaptureImage} src={props.screenshot} alt="" draggable={false} />
      ) : null}
      {props.markers.map(({ comment, number }) => (
        <div
          key={comment.id}
          className={css.reviewRegion}
          data-review-region={String(number)}
          data-status={comment.status}
          style={regionStyle(comment.target.rect, comment.context, props.scrollPosition)}
          title={comment.text}
        >
          <span className={css.reviewRegionPin}>{number}</span>
        </div>
      ))}
      {props.picked !== undefined ? (
        <div
          className={`${css.reviewRegion} ${css.reviewRegionPending}`}
          data-review-region={String(props.nextNumber)}
          style={regionStyle(props.picked.target.rect, props.picked.context, props.scrollPosition)}
        >
          <span className={css.reviewRegionPin}>{props.nextNumber}</span>
        </div>
      ) : null}
      {drawing !== undefined ? (
        <div className={`${css.reviewRegion} ${css.reviewRegionDrawing}`} style={drawing} />
      ) : null}
      {props.picked !== undefined && popover !== undefined ? (
        <form
          className={popover.className}
          style={popover.style}
          data-review-popover=""
          onSubmit={(event) => { void save(event) }}
          onPointerDown={(event) => { event.stopPropagation() }}
          onPointerMove={(event) => { event.stopPropagation() }}
          onPointerUp={(event) => { event.stopPropagation() }}
        >
          <strong className={css.reviewPopoverTitle}>{props.commentTitle}</strong>
          <textarea
            ref={textarea}
            className={css.reviewTextarea}
            value={text}
            maxLength={8000}
            placeholder={props.placeholder}
            disabled={props.busy || saving}
            onChange={(event) => { setText(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                props.onCancelPicked()
              } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void save()
              }
            }}
          />
          <div className={css.reviewPopoverActions}>
            <button type="button" className={css.reviewGhostButton} disabled={props.busy || saving} onClick={props.onCancelPicked}>
              {props.cancelLabel}
            </button>
            <button type="submit" className={css.reviewPrimaryButton} disabled={props.busy || saving || text.trim() === ''}>
              {props.saveLabel}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
