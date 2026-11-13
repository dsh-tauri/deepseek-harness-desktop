import { describe, expect, it } from 'vitest'
import { FALLBACK_DSH_TAG, FALLBACK_DSH_TAGS, MINIMUM_DSH_VERSION, parseVersionFromTag, pickReleaseTag } from './version'

describe('pickReleaseTag', () => {
  it('release 列表不可用时回退到候选列表，而不是单个可能已被删除的 tag', () => {
    const resolved = pickReleaseTag(undefined)
    expect(resolved.source).toBe('fallback')
    expect(resolved.tag).toBe(FALLBACK_DSH_TAG)
    expect(resolved.candidates).toEqual([...FALLBACK_DSH_TAGS])
    expect(resolved.version).toBe('0.2.2-rc.1')
  })

  it('release 列表里没有稳定版时同样给出候选列表', () => {
    const resolved = pickReleaseTag([{ tag: 'dsh-0.2.2-alpha.1-1', prerelease: true }])
    expect(resolved.source).toBe('fallback')
    expect(resolved.candidates.length).toBeGreaterThan(1)
  })

  it('正常列表下选最新的稳定 release', () => {
    const resolved = pickReleaseTag([
      { tag: 'dsh-0.2.2-rc.1-2', prerelease: false },
      { tag: 'dsh-0.2.2-rc.1-1', prerelease: false },
    ])
    expect(resolved.source).toBe('latest-stable')
    expect(resolved.tag).toBe('dsh-0.2.2-rc.1-2')
    expect(resolved.candidates).toEqual(['dsh-0.2.2-rc.1-2'])
  })

  it('显式 pin 直接生效', () => {
    const resolved = pickReleaseTag(undefined, { ref: 'dsh-0.2.2-rc.1-999' })
    expect(resolved.source).toBe('pin')
    expect(resolved.tag).toBe('dsh-0.2.2-rc.1-999')
    expect(resolved.candidates).toEqual(['dsh-0.2.2-rc.1-999'])
  })
})

describe('fALLBACK_DSH_TAGS', () => {
  it('候选 tag 都是受支持的 dsh 版本', () => {
    for (const tag of FALLBACK_DSH_TAGS) {
      const version = parseVersionFromTag(tag)
      expect(version, tag).toBeDefined()
      expect(version).toBe(MINIMUM_DSH_VERSION)
    }
  })

  it('候选 tag 不重复', () => {
    expect(new Set(FALLBACK_DSH_TAGS).size).toBe(FALLBACK_DSH_TAGS.length)
  })
})
