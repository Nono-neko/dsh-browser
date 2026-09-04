import { describe, expect, it } from 'vitest'
import type { ReviewCommentCreate } from '../src/core/review.ts'
import { ReviewStore, ReviewStoreError } from '../src/host/review-store.ts'

function input(overrides: Partial<ReviewCommentCreate> = {}): ReviewCommentCreate {
  return {
    workspaceRoot: 'C:/work/project',
    url: 'http://localhost:5173/',
    tabId: 'tab-1',
    text: 'Reduce the space above this heading.',
    target: {
      kind: 'element',
      source: { file: 'src/App.tsx', line: 12, column: 3 },
      selector: '#app > main > h1',
      textQuote: 'Dashboard',
      tagName: 'h1',
      attributes: { class: 'title' },
      outerHTML: '<h1 class="title">Dashboard</h1>',
      rect: { x: 10, y: 20, width: 200, height: 40 },
    },
    context: {
      viewportWidth: 1280,
      viewportHeight: 800,
      devicePixelRatio: 1,
      pageRevision: undefined,
    },
    ...overrides,
  }
}

function store(): ReviewStore {
  let clock = 100
  let id = 0
  return new ReviewStore({
    now: () => { clock += 1; return clock },
    id: kind => `${kind}-${++id}`,
  })
}

describe('ReviewStore', () => {
  it('creates and lists workspace-scoped draft comments', () => {
    const reviews = store()
    const created = reviews.create(input())
    reviews.create(input({ workspaceRoot: 'C:/work/other', text: 'Other workspace' }))

    expect(created.status).toBe('draft')
    expect(reviews.list('C:/work/project').map(comment => comment.id)).toEqual([created.id])
  })

  it('submits a confirmed draft group as one batch', () => {
    const reviews = store()
    const first = reviews.create(input())
    const second = reviews.create(input({ text: 'Use the secondary color here.' }))

    const view = reviews.createBatch('C:/work/project', [first.id, second.id, first.id])

    expect(view.batch.commentIds).toEqual([first.id, second.id])
    expect(view.comments.map(comment => comment.status)).toEqual(['submitted', 'submitted'])
    expect(view.comments.every(comment => comment.batchId === view.batch.id)).toBe(true)
  })

  it('rejects batching comments from another workspace', () => {
    const reviews = store()
    const comment = reviews.create(input({ workspaceRoot: 'C:/work/other' }))

    expect(() => reviews.createBatch('C:/work/project', [comment.id]))
      .toThrowError(ReviewStoreError)
  })

  it('resolves submitted comments and preserves the batch projection', () => {
    const reviews = store()
    const comment = reviews.create(input())
    const view = reviews.createBatch('C:/work/project', [comment.id])

    const resolved = reviews.resolve([comment.id])

    expect(resolved[0].status).toBe('resolved')
    expect(resolved[0].resolvedAt).toBeTypeOf('number')
    expect(reviews.getBatch(view.batch.id)?.comments[0].status).toBe('resolved')
  })

  it('reopens a batch when its Agent prompt was not enqueued', () => {
    const reviews = store()
    const comment = reviews.create(input())
    const view = reviews.createBatch('C:/work/project', [comment.id])

    const reopened = reviews.reopenBatch('C:/work/project', view.batch.id)

    expect(reopened[0]).toMatchObject({ id: comment.id, status: 'draft', batchId: undefined })
    expect(reviews.getBatch(view.batch.id)).toBeUndefined()
    expect(() => reviews.reopenBatch('C:/work/project', view.batch.id)).toThrow(ReviewStoreError)
  })

  it('rejects empty user comments', () => {
    const reviews = store()
    expect(() => reviews.create(input({ text: '   ' }))).toThrow(/comment text/)
  })
})
