/**
 * SSRF defense for browser_read: every fetch target is resolved through DNS
 * before the request leaves the process, and private-range addresses are
 * rejected unless the user explicitly enables allowPrivateAccess. Redirects
 * are followed manually so every hop is re-checked (a public URL that
 * redirects to 192.168.0.1 must not bypass the guard).
 * @module dsh-browser/host/ssrf-guard
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Timeout for the pre-flight DNS resolution. */
const DNS_TIMEOUT_MS = 5_000

/**
 * Whether one IPv4/IPv6 address is in a private, loopback, link-local,
 * reserved or otherwise non-public range.
 */
export function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) return isPrivateIPv6(address)
  return isPrivateIPv4(address)
}

/** Parse an IPv4 address into a 32-bit number; null when malformed. */
function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function isPrivateIPv4(address: string): boolean {
  const value = ipv4ToNumber(address)
  if (value === null) return true // malformed input is never trusted
  return inRange(value, '0.0.0.0', '0.255.255.255') // 0.0.0.0/8 "this network"
    || inRange(value, '10.0.0.0', '10.255.255.255') // 10.0.0.0/8
    || inRange(value, '100.64.0.0', '100.127.255.255') // 100.64.0.0/10 CGNAT
    || inRange(value, '127.0.0.0', '127.255.255.255') // loopback
    || inRange(value, '169.254.0.0', '169.254.255.255') // link-local
    || inRange(value, '172.16.0.0', '172.31.255.255') // 172.16.0.0/12
    || inRange(value, '192.0.0.0', '192.0.0.255') // IETF protocol assignments
    || inRange(value, '192.0.2.0', '192.0.2.255') // TEST-NET-1
    || inRange(value, '192.168.0.0', '192.168.255.255') // 192.168.0.0/16
    || inRange(value, '198.18.0.0', '198.19.255.255') // benchmarking
    || inRange(value, '198.51.100.0', '198.51.100.255') // TEST-NET-2
    || inRange(value, '203.0.113.0', '203.0.113.255') // TEST-NET-3
    || inRange(value, '224.0.0.0', '255.255.255.255') // multicast + reserved + broadcast
}

function inRange(value: number, start: string, end: string): boolean {
  const from = ipv4ToNumber(start)
  const to = ipv4ToNumber(end)
  if (from === null || to === null) return false
  return value >= from && value <= to
}

/** IPv4-mapped IPv6 (::ffff:a.b.c.d) reuses the IPv4 judgment. */
const V4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/

function isPrivateIPv6(address: string): boolean {
  const mapped = V4_MAPPED.exec(address.toLowerCase())
  if (mapped !== null) return isPrivateIPv4(mapped[1])
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true // fc00::/7 unique local
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb')) return true // fe80::/10 link-local
  if (normalized.startsWith('ff')) return true // multicast
  return false
}

/**
 * Resolve a hostname and verify every address is public. A hostname that
 * resolves to a mix of public and private addresses is rejected (the fetch
 * could land on either).
 * @param hostname - URL hostname (brackets already stripped by URL).
 * @returns undefined when the host is safe; an error message otherwise.
 */
export async function assertPublicHost(hostname: string): Promise<string | undefined> {
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (isIP(bare) !== 0) {
    return isPrivateAddress(bare) ? `address ${bare} is not a public address` : undefined
  }
  let addresses: string[]
  try {
    const result = await Promise.race([
      lookup(bare, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS)
      }),
    ])
    addresses = result.map(entry => entry.address)
  } catch {
    return `cannot resolve hostname ${bare}`
  }
  if (addresses.length === 0) return `hostname ${bare} resolves to no addresses`
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return `hostname ${bare} resolves to private address ${address}`
    }
  }
  return undefined
}
