import { describe, expect, it } from 'vitest'
import { displayLabel, isHttpUrl, normalizeAddress, tryParseHttp } from '../src/core/url.ts'

describe('normalizeAddress', () => {
  it('keeps http(s) URLs as-is', () => {
    expect(normalizeAddress('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(normalizeAddress('http://example.com')).toBe('http://example.com/')
  })

  it('prepends https:// to dotted hosts', () => {
    expect(normalizeAddress('example.com/path')).toBe('https://example.com/path')
  })

  it('opens dotted hosts with an explicit port', () => {
    expect(normalizeAddress('example.com:8080/path')).toBe('https://example.com:8080/path')
  })

  it('opens localhost and IPv6 development addresses with a port', () => {
    expect(normalizeAddress('localhost:3000')).toBe('https://localhost:3000/')
    expect(normalizeAddress('[::1]:3000')).toBe('https://[::1]:3000/')
  })

  it('turns bare words into a search query', () => {
    expect(normalizeAddress('deepseek harness')).toBe('https://www.bing.com/search?q=deepseek%20harness')
  })

  it('rejects file/javascript/data schemes', () => {
    expect(normalizeAddress('file:///C:/x.html')).toBeNull()
    expect(normalizeAddress('javascript:alert(1)')).toBeNull()
    expect(normalizeAddress('data:text/html,x')).toBeNull()
  })

  it('rejects unknown schemes and empty input', () => {
    expect(normalizeAddress('ftp://example.com')).toBeNull()
    expect(normalizeAddress('   ')).toBeNull()
  })
})

describe('tryParseHttp / isHttpUrl', () => {
  it('accepts http and https only', () => {
    expect(tryParseHttp('https://a.b')).not.toBeNull()
    expect(tryParseHttp('ftp://a.b')).toBeNull()
    expect(tryParseHttp('not a url')).toBeNull()
  })

  it('detects http URLs for the open-external gate', () => {
    expect(isHttpUrl('https://a.b')).toBe(true)
    expect(isHttpUrl('/api/dsh-browser/file?root=x&path=y')).toBe(false)
    expect(isHttpUrl('start')).toBe(false)
  })
})

describe('displayLabel', () => {
  it('labels http(s) URLs by hostname', () => {
    expect(displayLabel('https://example.com/')).toBe('example.com')
    expect(displayLabel('https://example.com/a/b')).toBe('example.com/a/b')
  })

  it('labels workspace-file URLs by their relative path', () => {
    const url = `/api/dsh-browser/file?root=${encodeURIComponent('C:/work/proj')}&path=${encodeURIComponent('docs/readme.md')}`
    expect(displayLabel(url)).toBe('proj/readme.md')
  })
})
