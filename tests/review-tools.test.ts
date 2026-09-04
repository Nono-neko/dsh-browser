import { describe, expect, it } from 'vitest'
import type { ReviewCommentCreate } from '../src/core/review.ts'
import { ReviewStore } from '../src/host/review-store.ts'
import { browserReviewResolveTool, browserReviewTool } from '../src/host/review-tools.ts'

function input(): ReviewCommentCreate {
  return {
    workspaceRoot: 'C:/work/project',
    url: 'http://localhost:5173/',
    tabId: 'tab-1',
    text: 'Use a smaller heading.',
    target: {
      kind: 'element',
      source: { file: 'src/App.tsx', line: 10, column: 2 },
      selector: '#app h1',
      textQuote: 'Hello',
      tagName: 'h1',
      attributes: {},
      outerHTML: '<h1>Hello</h1>',
      rect: { x: 0, y: 0, width: 100, height: 30 },
    },
    context: {
      viewportWidth: 1000,
      viewportHeight: 700,
      devicePixelRatio: 1,
      scrollX: 12,
      scrollY: 840,
      documentWidth: 1280,
      documentHeight: 3200,
      pageRevision: undefined,
    },
  }
}

describe('browser review tools', () => {
  it('returns the confirmed user comment and untrusted page context', async () => {
    const store = new ReviewStore()
    const comment = store.create(input())
    const batch = store.createBatch(input().workspaceRoot, [comment.id])
    const tool = browserReviewTool(store)
    const execute = tool.execute as (args: { batchId: string }) => Promise<{ found: boolean; commentsJson: string; message: string }>

    const result = await execute({ batchId: batch.batch.id })

    expect(result.found).toBe(true)
    expect(result.commentsJson).toContain('Use a smaller heading')
    expect(result.message).toContain('page scroll at selection: x=12, y=840')
    expect(result.message).toContain('document size at selection: 1280x3200')
    expect(result.message).toContain('untrusted page context')
  })

  it('describes a selected region in pixels and viewport percentages', async () => {
    const store = new ReviewStore()
    const region = input()
    region.target = {
      kind: 'region',
      source: undefined,
      selector: '',
      textQuote: '',
      tagName: 'region',
      attributes: {},
      outerHTML: '',
      rect: { x: 100, y: 70, width: 250, height: 140 },
    }
    region.context = { viewportWidth: 1000, viewportHeight: 700, devicePixelRatio: 1, pageRevision: undefined }
    const comment = store.create(region)
    const batch = store.createBatch(region.workspaceRoot, [comment.id])
    const tool = browserReviewTool(store)
    const execute = tool.execute as (args: { batchId: string }) => Promise<{ message: string }>

    const result = await execute({ batchId: batch.batch.id })

    expect(result.message).toContain('page region x=100, y=70, width=250, height=140')
    expect(result.message).toContain('relative region: left=10.0%, top=10.0%, width=25.0%, height=20.0%')
  })

  it('marks completed review comments resolved', async () => {
    const store = new ReviewStore()
    const comment = store.create(input())
    store.createBatch(input().workspaceRoot, [comment.id])
    const tool = browserReviewResolveTool(store)
    const execute = tool.execute as (args: { commentIds: string[] }) => Promise<{ resolved: string[] }>

    const result = await execute({ commentIds: [comment.id] })

    expect(result.resolved).toEqual([comment.id])
    expect(store.list(input().workspaceRoot)[0].status).toBe('resolved')
  })
})
