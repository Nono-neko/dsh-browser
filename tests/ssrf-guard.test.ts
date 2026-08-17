import { describe, expect, it } from 'vitest'
import { isPrivateAddress } from '../src/host/ssrf-guard.ts'

describe('isPrivateAddress (IPv4)', () => {
  const privates = [
    '10.0.0.1', '10.255.255.255',
    '127.0.0.1', '127.8.8.8',
    '169.254.1.1',
    '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '192.168.255.255',
    '100.64.0.1',
    '0.0.0.0', '0.1.2.3',
    '198.18.0.1',
    '224.0.0.1', '255.255.255.255',
    '192.0.2.1', '198.51.100.7', '203.0.113.9',
  ]
  for (const address of privates) {
    it(`rejects ${address}`, () => {
      expect(isPrivateAddress(address)).toBe(true)
    })
  }

  const publics = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '223.5.5.5']
  for (const address of publics) {
    it(`accepts ${address}`, () => {
      expect(isPrivateAddress(address)).toBe(false)
    })
  }

  it('rejects malformed input', () => {
    expect(isPrivateAddress('999.1.1.1')).toBe(true)
    expect(isPrivateAddress('not-an-ip')).toBe(true)
  })
})

describe('isPrivateAddress (IPv6)', () => {
  it('rejects loopback, unique-local, link-local, multicast and mapped v4', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fc00::1')).toBe(true)
    expect(isPrivateAddress('fd12:3456::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('ff02::1')).toBe(true)
    expect(isPrivateAddress('::ffff:192.168.0.1')).toBe(true)
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('accepts ordinary global addresses', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
  })
})
