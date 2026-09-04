/**
 * Structured browser-review contracts shared by the Host and Client halves.
 * Review comments are user-authored instructions anchored to one rendered
 * workspace page. Page-derived fields are context only and must never be
 * treated as trusted instructions by an agent.
 * @module dsh-browser/core/review
 */

/** Optional source location emitted by workspace development instrumentation. */
export interface ReviewSourceLocation {
  file: string
  line: number | undefined
  column: number | undefined
}

/** Browser viewport rectangle of one selected region or exact element click point. */
export interface ReviewRect {
  x: number
  y: number
  width: number
  height: number
}

export type ReviewTargetKind = 'element' | 'region'

/**
 * One page-review anchor. Region anchors are always available from the parent
 * browser surface; DOM fields may be empty when the embedded page cannot be
 * inspected safely.
 */
export interface ReviewTarget {
  kind: ReviewTargetKind
  source: ReviewSourceLocation | undefined
  selector: string
  textQuote: string
  tagName: string
  attributes: Record<string, string>
  outerHTML: string
  rect: ReviewRect
}

/** View facts captured with a review target. */
export interface ReviewContext {
  viewportWidth: number
  viewportHeight: number
  devicePixelRatio: number
  scrollX?: number
  scrollY?: number
  documentWidth?: number
  documentHeight?: number
  pageRevision: string | undefined
}

/** Browser-captured page image attached to the confirmed Agent turn. */
export interface ReviewScreenshot {
  url: string
  viewportWidth: number
  viewportHeight: number
  mediaType: 'image/png'
  data: string
  name: string
}

export type ReviewStatus = 'draft' | 'submitted' | 'resolved'

/** One durable-for-the-host-lifetime review comment. */
export interface ReviewComment {
  id: string
  workspaceRoot: string
  url: string
  tabId: string
  text: string
  target: ReviewTarget
  context: ReviewContext
  status: ReviewStatus
  batchId: string | undefined
  createdAt: number
  resolvedAt: number | undefined
}

/** Client payload accepted when a user creates a comment. */
export type ReviewCommentCreate = Pick<
  ReviewComment,
  'workspaceRoot' | 'url' | 'tabId' | 'text' | 'target' | 'context'
>

/** A user-confirmed group handed to one Agent turn. */
export interface ReviewBatch {
  id: string
  workspaceRoot: string
  commentIds: string[]
  createdAt: number
}

/** The Agent-facing batch projection. */
export interface ReviewBatchView {
  batch: ReviewBatch
  comments: ReviewComment[]
}
