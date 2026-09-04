/**
 * Host-lifetime review storage. The browser Client posts draft comments here
 * so Agent tools can read the same structured records. Persistence across a
 * Host restart is deliberately deferred until DSH exposes an official plugin
 * data directory service.
 * @module dsh-browser/host/review-store
 */

import { randomUUID } from 'node:crypto'
import type {
  ReviewBatch,
  ReviewBatchView,
  ReviewComment,
  ReviewCommentCreate,
  ReviewStatus,
} from '../core/review.ts'

const MAX_COMMENTS_PER_ROOT = 500

export class ReviewStoreError extends Error {
  constructor(
    readonly code: 'invalid' | 'not-found' | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'ReviewStoreError'
  }
}

export interface ReviewStoreDeps {
  now?: () => number
  id?: (kind: 'comment' | 'batch') => string
}

export class ReviewStore {
  private readonly comments = new Map<string, ReviewComment>()
  private readonly batches = new Map<string, ReviewBatch>()
  private readonly now: () => number
  private readonly id: (kind: 'comment' | 'batch') => string

  constructor(deps: ReviewStoreDeps = {}) {
    this.now = deps.now ?? Date.now
    this.id = deps.id ?? (kind => `${kind}-${randomUUID()}`)
  }

  create(input: ReviewCommentCreate): ReviewComment {
    validateCreate(input)
    const count = this.list(input.workspaceRoot).length
    if (count >= MAX_COMMENTS_PER_ROOT) {
      throw new ReviewStoreError('conflict', `workspace review limit reached (${MAX_COMMENTS_PER_ROOT})`)
    }
    const comment: ReviewComment = {
      ...input,
      id: this.id('comment'),
      status: 'draft',
      batchId: undefined,
      createdAt: this.now(),
      resolvedAt: undefined,
    }
    this.comments.set(comment.id, freezeComment(comment))
    return cloneComment(comment)
  }

  list(workspaceRoot: string, statuses?: readonly ReviewStatus[]): ReviewComment[] {
    const allowed = statuses === undefined ? undefined : new Set(statuses)
    return [...this.comments.values()]
      .filter(comment => comment.workspaceRoot === workspaceRoot && (allowed === undefined || allowed.has(comment.status)))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneComment)
  }

  deleteDraft(workspaceRoot: string, commentId: string): ReviewComment {
    const comment = this.comments.get(commentId)
    if (comment === undefined || comment.workspaceRoot !== workspaceRoot) {
      throw new ReviewStoreError('not-found', `review comment not found: ${commentId}`)
    }
    if (comment.status !== 'draft') {
      throw new ReviewStoreError('conflict', `review comment is not a draft: ${commentId}`)
    }
    this.comments.delete(commentId)
    return cloneComment(comment)
  }

  createBatch(workspaceRoot: string, commentIds: readonly string[]): ReviewBatchView {
    const unique = [...new Set(commentIds)]
    if (workspaceRoot === '' || unique.length === 0) {
      throw new ReviewStoreError('invalid', 'a workspace root and at least one comment are required')
    }
    const comments = unique.map((id) => {
      const comment = this.comments.get(id)
      if (comment === undefined || comment.workspaceRoot !== workspaceRoot) {
        throw new ReviewStoreError('not-found', `review comment not found: ${id}`)
      }
      if (comment.status !== 'draft') {
        throw new ReviewStoreError('conflict', `review comment is not a draft: ${id}`)
      }
      return comment
    })
    const batch: ReviewBatch = {
      id: this.id('batch'),
      workspaceRoot,
      commentIds: unique,
      createdAt: this.now(),
    }
    this.batches.set(batch.id, Object.freeze({ ...batch, commentIds: Object.freeze([...unique]) }) as ReviewBatch)
    for (const comment of comments) {
      this.comments.set(comment.id, freezeComment({ ...comment, status: 'submitted', batchId: batch.id }))
    }
    return this.getBatch(batch.id) as ReviewBatchView
  }

  getBatch(batchId: string): ReviewBatchView | undefined {
    const batch = this.batches.get(batchId)
    if (batch === undefined) return undefined
    const comments = batch.commentIds
      .map(id => this.comments.get(id))
      .filter((comment): comment is ReviewComment => comment !== undefined)
      .map(cloneComment)
    return {
      batch: { ...batch, commentIds: [...batch.commentIds] },
      comments,
    }
  }

  /** Restore a just-created batch when enqueueing its Agent prompt fails. */
  reopenBatch(workspaceRoot: string, batchId: string): ReviewComment[] {
    const batch = this.batches.get(batchId)
    if (batch === undefined || batch.workspaceRoot !== workspaceRoot) {
      throw new ReviewStoreError('not-found', `review batch not found: ${batchId}`)
    }
    const comments = batch.commentIds.map((id) => {
      const comment = this.comments.get(id)
      if (comment === undefined || comment.workspaceRoot !== workspaceRoot) {
        throw new ReviewStoreError('not-found', `review comment not found: ${id}`)
      }
      if (comment.status !== 'submitted' || comment.batchId !== batchId) {
        throw new ReviewStoreError('conflict', `review batch can no longer be reopened: ${batchId}`)
      }
      return comment
    })
    for (const comment of comments) {
      this.comments.set(comment.id, freezeComment({
        ...comment,
        status: 'draft',
        batchId: undefined,
      }))
    }
    this.batches.delete(batchId)
    return comments.map(comment => cloneComment(this.comments.get(comment.id) as ReviewComment))
  }

  resolve(commentIds: readonly string[], workspaceRoot?: string): ReviewComment[] {
    const unique = [...new Set(commentIds)]
    if (unique.length === 0) throw new ReviewStoreError('invalid', 'at least one comment is required')
    const comments = unique.map((id) => {
      const comment = this.comments.get(id)
      if (comment === undefined) throw new ReviewStoreError('not-found', `review comment not found: ${id}`)
      if (workspaceRoot !== undefined && comment.workspaceRoot !== workspaceRoot) {
        throw new ReviewStoreError('not-found', `review comment not found: ${id}`)
      }
      return comment
    })
    const resolvedAt = this.now()
    for (const comment of comments) {
      if (comment.status === 'resolved') continue
      this.comments.set(comment.id, freezeComment({ ...comment, status: 'resolved', resolvedAt }))
    }
    return unique.map(id => cloneComment(this.comments.get(id) as ReviewComment))
  }
}

function validateCreate(input: ReviewCommentCreate): void {
  if (input.workspaceRoot.trim() === '') throw new ReviewStoreError('invalid', 'workspace root is required')
  if (input.url.trim() === '' || input.url.length > 8_192) throw new ReviewStoreError('invalid', 'page URL is invalid')
  if (input.tabId.trim() === '' || input.tabId.length > 256) throw new ReviewStoreError('invalid', 'tab id is invalid')
  if (input.text.trim() === '' || input.text.length > 8_000) throw new ReviewStoreError('invalid', 'comment text is invalid')
  if (input.target.selector.length > 4_096 || input.target.outerHTML.length > 16_000 || input.target.textQuote.length > 2_000) {
    throw new ReviewStoreError('invalid', 'review target exceeds its size limit')
  }
  const numbers = [
    input.target.rect.x,
    input.target.rect.y,
    input.target.rect.width,
    input.target.rect.height,
    input.context.viewportWidth,
    input.context.viewportHeight,
    input.context.devicePixelRatio,
    input.context.scrollX,
    input.context.scrollY,
    input.context.documentWidth,
    input.context.documentHeight,
  ]
  if (!numbers.every(value => value === undefined || Number.isFinite(value))) {
    throw new ReviewStoreError('invalid', 'review geometry is invalid')
  }
}

function freezeComment(comment: ReviewComment): ReviewComment {
  return Object.freeze({
    ...comment,
    target: Object.freeze({
      ...comment.target,
      source: comment.target.source === undefined ? undefined : Object.freeze({ ...comment.target.source }),
      attributes: Object.freeze({ ...comment.target.attributes }),
      rect: Object.freeze({ ...comment.target.rect }),
    }),
    context: Object.freeze({ ...comment.context }),
  }) as ReviewComment
}

function cloneComment(comment: ReviewComment): ReviewComment {
  return {
    ...comment,
    target: {
      ...comment.target,
      source: comment.target.source === undefined ? undefined : { ...comment.target.source },
      attributes: { ...comment.target.attributes },
      rect: { ...comment.target.rect },
    },
    context: { ...comment.context },
  }
}
