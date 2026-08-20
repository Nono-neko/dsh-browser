import { describe, expect, it } from 'vitest'
import configs from '../tsdown.config'

type ResolveHook = (source: string, importer?: string) => unknown

function purityResolver(): ResolveHook {
  const client = configs[1] as unknown as {
    plugins?: Array<{ name?: string, resolveId?: unknown }>
  }
  const plugin = client.plugins?.find(candidate => candidate.name === 'dsh-client-bundle-purity')
  if (!plugin || typeof plugin !== 'object' || typeof plugin.resolveId !== 'function') {
    throw new Error('client bundle purity plugin is missing')
  }
  return plugin.resolveId.bind({}) as ResolveHook
}

describe('client bundle purity gate', () => {
  it('allows only modules supplied by the browser platform table', () => {
    const resolveId = purityResolver()

    expect(resolveId('react')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-client-ui-slots')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-client-runtime/client')).toBeNull()
  })

  it('rejects non-platform DeepSeek value imports even when they look browser-safe', () => {
    const resolveId = purityResolver()

    expect(() => resolveId('@deepseek-ai/dsh-tools')).toThrow(/client bundle purity/)
    expect(() => resolveId('@deepseek-ai/dsh-session/remote')).toThrow(/client bundle purity/)
  })
})
