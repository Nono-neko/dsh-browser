import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewComment } from '../src/core/review.ts'
import { ReviewOverlay } from '../src/client/panel/ReviewOverlay.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function pointer(type: string, x: number, y: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  return event
}

function comment(): ReviewComment {
  return {
    id: 'comment-1',
    workspaceRoot: 'C:/work/project',
    url: 'http://localhost:5173/',
    tabId: 'tab-1',
    text: 'Reduce this area.',
    target: {
      kind: 'region',
      source: undefined,
      selector: '',
      textQuote: '',
      tagName: 'region',
      attributes: {},
      outerHTML: '',
      rect: { x: 100, y: 50, width: 300, height: 100 },
    },
    context: { viewportWidth: 1000, viewportHeight: 500, devicePixelRatio: 1, pageRevision: undefined },
    status: 'draft',
    batchId: undefined,
    createdAt: 1,
    resolvedAt: undefined,
  }
}

describe('ReviewOverlay', () => {
  it('creates a parent-layer region from a drag without iframe cooperation', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onPick = vi.fn()
    act(() => {
      root.render(createElement(ReviewOverlay, {
        picking: true,
        picked: undefined,
        markers: [],
        nextNumber: 1,
        label: 'review canvas',
        commentTitle: 'Comment #1',
        placeholder: 'Describe the change',
        saveLabel: 'Save',
        cancelLabel: 'Cancel',
        busy: false,
        screenshot: undefined,
        onPick,
        onCreate: async () => true,
        onCancelPicked: vi.fn(),
      }))
    })
    const overlay = host.querySelector('[data-review-overlay]') as HTMLDivElement
    overlay.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 620,
      width: 800, height: 600, toJSON: () => ({}),
    })

    act(() => { overlay.dispatchEvent(pointer('pointerdown', 110, 140)) })
    act(() => { overlay.dispatchEvent(pointer('pointermove', 310, 300)) })
    act(() => { overlay.dispatchEvent(pointer('pointerup', 310, 300)) })

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toMatchObject({
      target: { kind: 'region', rect: { x: 100, y: 120, width: 200, height: 160 } },
      context: { viewportWidth: 800, viewportHeight: 600 },
    })
    act(() => { root.unmount() })
    host.remove()
  })

  it('renders numbered markers using viewport-relative positions', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(ReviewOverlay, {
        picking: false,
        picked: undefined,
        markers: [{ comment: comment(), number: 3 }],
        nextNumber: 4,
        label: 'review canvas',
        commentTitle: 'Comment #4',
        placeholder: 'Describe the change',
        saveLabel: 'Save',
        cancelLabel: 'Cancel',
        busy: false,
        screenshot: 'data:image/png;base64,AQID',
        onPick: vi.fn(),
        onCreate: async () => true,
        onCancelPicked: vi.fn(),
      }))
    })

    const region = host.querySelector('[data-review-region="3"]') as HTMLDivElement
    expect(region.style.left).toBe('10%')
    expect(region.style.top).toBe('10%')
    expect(region.style.width).toBe('30%')
    expect(region.textContent).toBe('3')
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID')
    act(() => { root.unmount() })
    host.remove()
  })

  it('renders an editable comment box beside the picked point', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onCreate = vi.fn(async () => true)
    const value = comment()
    value.target.rect = { x: 800, y: 400, width: 1, height: 1 }
    value.context.scrollX = 0
    value.context.scrollY = 900
    await act(async () => {
      root.render(createElement(ReviewOverlay, {
        picking: false,
        picked: { target: value.target, context: value.context },
        markers: [],
        nextNumber: 1,
        label: 'review canvas',
        commentTitle: 'Comment #1',
        placeholder: 'Describe the change',
        saveLabel: 'Save',
        cancelLabel: 'Cancel',
        busy: false,
        scrollPosition: { x: 0, y: 1_000 },
        screenshot: undefined,
        onPick: vi.fn(),
        onCreate,
        onCancelPicked: vi.fn(),
      }))
    })

    const popover = host.querySelector('[data-review-popover]') as HTMLFormElement
    const textarea = popover.querySelector('textarea') as HTMLTextAreaElement
    expect(popover.style.left).toBe('80.05%')
    expect(Number.parseFloat(popover.style.top)).toBeCloseTo(60.1)
    expect((host.querySelector('[data-review-region="1"]') as HTMLDivElement).style.top).toBe('60%')
    expect(popover.className).toContain('reviewPopoverLeft')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Move this card lower.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { popover.requestSubmit() })
    expect(onCreate).toHaveBeenCalledWith('Move this card lower.')

    act(() => { root.unmount() })
    host.remove()
  })
})
