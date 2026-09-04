import { describe, expect, it } from 'vitest'
import { isPreviewableImage } from '../src/core/editor.ts'

describe('isPreviewableImage', () => {
  it('recognizes common browser image formats case-insensitively', () => {
    expect(isPreviewableImage('assets/avatar.PNG')).toBe(true)
    expect(isPreviewableImage('icons/logo.svg')).toBe(true)
    expect(isPreviewableImage('animation.gif')).toBe(true)
  })

  it('keeps source and extensionless files in the text editor path', () => {
    expect(isPreviewableImage('src/App.tsx')).toBe(false)
    expect(isPreviewableImage('README')).toBe(false)
    expect(isPreviewableImage('.png')).toBe(false)
  })
})
