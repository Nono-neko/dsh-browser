import { describe, expect, it } from 'vitest'
import { decodeEntities, extractText, extractTitle } from '../src/core/text.ts'

describe('extractTitle', () => {
  it('reads the title element', () => {
    expect(extractTitle('<html><head><title>Hello &amp; World</title></head></html>')).toBe('Hello & World')
  })

  it('falls back to the first h1', () => {
    expect(extractTitle('<html><body><h1>Doc <b>Title</b></h1></body></html>')).toBe('Doc Title')
  })

  it('returns undefined when neither exists', () => {
    expect(extractTitle('<html><body><p>text</p></body></html>')).toBeUndefined()
  })
})

describe('extractText', () => {
  it('strips scripts and styles entirely', () => {
    const html = '<html><head><style>.a{}</style></head><body><script>var x = 1;</script><p>visible</p></body></html>'
    const { text } = extractText(html, 1000)
    expect(text).toContain('visible')
    expect(text).not.toContain('var x')
    expect(text).not.toContain('.a{}')
  })

  it('strips every consecutive hidden-content tree', () => {
    const html = '<script>first()</script><script>second()</script><style>.first{}</style><style>.second{}</style><p>visible</p>'
    const { text } = extractText(html, 1000)
    expect(text).toBe('visible')
  })

  it('strips nested hidden-content trees at their full depth', () => {
    const html = '<template><template>inner</template>outer</template><p>visible</p>'
    const { text } = extractText(html, 1000)
    expect(text).toBe('visible')
  })

  it('turns block boundaries into line breaks and bullets li items', () => {
    const html = '<ul><li>one</li><li>two</li></ul><p>after</p>'
    const { text } = extractText(html, 1000)
    expect(text).toContain('- one')
    expect(text).toContain('- two')
    expect(text).toContain('after')
  })

  it('decodes entities and collapses whitespace', () => {
    const { text } = extractText('<p>a&nbsp;&nbsp;b &#65; &lt;x&gt;</p>', 1000)
    expect(text).toContain('a b A <x>')
  })

  it('truncates to maxChars and reports it', () => {
    const { text, truncated } = extractText(`<p>${'word '.repeat(1000)}</p>`, 50)
    expect(text.length).toBeLessThanOrEqual(50)
    expect(truncated).toBe(true)
  })

  it('leaves short text untruncated', () => {
    const { text, truncated } = extractText('<p>short</p>', 50)
    expect(text).toContain('short')
    expect(truncated).toBe(false)
  })
})

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('&lt;&gt;&amp;&#65;&#x42;')).toBe('<>&AB')
  })

  it('drops out-of-range codepoints', () => {
    expect(decodeEntities('&#99999999;')).toBe('')
  })
})
