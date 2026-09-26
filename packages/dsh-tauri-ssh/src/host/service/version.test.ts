import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FALLBACK_DSH_TAG,
  isPreviewTag,
  OFFICIAL_INSTALL_REPO,
  OFFICIAL_PKG_REPO,
  parseGitHubRepo,
  parseVersionFromTag,
  pickReleaseTag,
  pkgRepoOf,
  RECOMMENDED_DSH_VERSION,
} from './version'

/** A realistic newest-first release list (test tags republishing included). */
const RELEASES = [
  { tag: 'dsh-0.2.0-preview.1-32490000001', prerelease: true },
  { tag: 'dsh-0.1.5-rc.3-35833820356', prerelease: false },
  { tag: 'dsh-0.1.2-rc.1-33729514615', prerelease: false },
  { tag: 'dsh-0.1.1-rc.1-32342588166', prerelease: false },
  { tag: 'dsh-0.1.0-rc.8-32342588167', prerelease: false },
  { tag: 'dsh-0.1.0-rc.8-32331963388', prerelease: false },
  { tag: 'dsh-0.1.0-beta.1-32490000002', prerelease: false },
]

describe('parseVersionFromTag', () => {
  it('extracts the semver from build-id tags', () => {
    expect(parseVersionFromTag('dsh-0.1.2-rc.1-33729514615')).toBe('0.1.2-rc.1')
    expect(parseVersionFromTag('dsh-0.1.0-rc.8-32342588167')).toBe('0.1.0-rc.8')
    // Bare dsh-prefixed tags always lose their last dash segment (the build-id
    // convention) — matching the retired Rust parser exactly.
    expect(parseVersionFromTag('dsh-0.1.2-rc.1')).toBe('0.1.2')
  })

  it('handles src tags and rejects tags without a version', () => {
    expect(parseVersionFromTag('dsh-src-0.1.2-alpha.1-33260039971')).toBe('0.1.2-alpha.1')
    expect(parseVersionFromTag('src-0.1.2-alpha.1')).toBe('0.1.2-alpha.1')
    expect(parseVersionFromTag('v99')).toBeUndefined()
    expect(parseVersionFromTag('')).toBeUndefined()
  })
})

describe('isPreviewTag', () => {
  it('flags non-rc pre-release markers only', () => {
    expect(isPreviewTag('dsh-0.2.0-preview.1-1')).toBe(true)
    expect(isPreviewTag('dsh-0.1.0-beta.1-2')).toBe(true)
    expect(isPreviewTag('dsh-0.1.2-rc.1-33729514615')).toBe(false)
    expect(isPreviewTag('dsh-0.1.2-33729514615')).toBe(false)
    expect(isPreviewTag('not-a-tag')).toBe(false)
  })
})

describe('pickReleaseTag', () => {
  it('resolves the recommended version onto its release tag (recommended path)', () => {
    const resolved = pickReleaseTag(RELEASES)
    expect(resolved).toMatchObject({ tag: 'dsh-0.1.5-rc.3-35833820356', version: RECOMMENDED_DSH_VERSION, source: 'recommended' })
    expect(resolved.notes).toEqual([])
  })

  it('dedupes republished versions keeping the newest-listed tag', () => {
    const resolved = pickReleaseTag(RELEASES, { recommended: '0.1.0-rc.8' })
    expect(resolved.tag).toBe('dsh-0.1.0-rc.8-32342588167')
  })

  it('prefers the non-src republish of a version (newest-first listing)', () => {
    // Mirrors the live pkg repo: `dsh-0.1.2-alpha.4` (newer) and the older
    // `dsh-src-0.1.2-alpha.4` parse to the same version; newest-first order
    // must keep the `dsh-` variant.
    const srcPair = [
      { tag: 'dsh-0.1.2-alpha.4-33260040123', prerelease: false },
      { tag: 'dsh-src-0.1.2-alpha.4-33260039971', prerelease: false },
    ]
    expect(pickReleaseTag(srcPair, { recommended: '0.1.2-alpha.4' }).tag).toBe('dsh-0.1.2-alpha.4-33260040123')
  })

  it('honors an explicit tag pin, listed or not', () => {
    expect(pickReleaseTag(RELEASES, { ref: 'dsh-0.1.1-rc.1-32342588166' })).toMatchObject({
      tag: 'dsh-0.1.1-rc.1-32342588166',
      source: 'pin',
    })
    const unlisted = pickReleaseTag(RELEASES, { ref: 'dsh-0.1.1-rc.2-999' })
    expect(unlisted.source).toBe('pin')
    expect(unlisted.notes[0]).toContain('不在 release 列表')
  })

  it('honors an explicit version pin', () => {
    expect(pickReleaseTag(RELEASES, { ref: '0.1.1-rc.1' })).toMatchObject({
      tag: 'dsh-0.1.1-rc.1-32342588166',
      version: '0.1.1-rc.1',
      source: 'pin',
    })
  })

  it('falls back to the newest stable release when the recommended version is absent', () => {
    const resolved = pickReleaseTag(RELEASES, { recommended: '0.3.0' })
    expect(resolved.source).toBe('latest-stable')
    expect(resolved.tag).toBe('dsh-0.1.5-rc.3-35833820356')
    expect(resolved.notes[0]).toContain('回退最新稳定')
  })

  it('skips preview releases in the stable fallback', () => {
    const previewTop = [
      { tag: 'dsh-0.2.0-preview.1-1', prerelease: true },
      { tag: 'dsh-0.1.2-rc.1-33729514615', prerelease: false },
    ]
    expect(pickReleaseTag(previewTop, { recommended: '0.9.9' }).tag).toBe('dsh-0.1.2-rc.1-33729514615')
  })

  it('falls back to the known stable tag when the release list is unavailable', () => {
    const resolved = pickReleaseTag(undefined)
    expect(resolved).toMatchObject({ tag: FALLBACK_DSH_TAG, source: 'fallback' })
    expect(resolved.notes[0]).toContain('回退已知稳定 tag')
  })

  it('falls back when the list is empty or everything is a preview', () => {
    expect(pickReleaseTag([]).source).toBe('fallback')
    expect(pickReleaseTag([{ tag: 'dsh-0.2.0-preview.1-1', prerelease: true }]).source).toBe('fallback')
  })

  it('notes an unresolvable version pin before falling back', () => {
    const resolved = pickReleaseTag(RELEASES, { ref: '9.9.9' })
    expect(resolved.source).toBe('recommended')
    expect(resolved.notes[0]).toContain('回退推荐/最新稳定版')
  })
})

describe('recommended version lockstep', () => {
  it('follows the desktop mainline manifest.jsonc', () => {
    const raw = readFileSync(new URL('../../../../../src-tauri/resources/manifest.jsonc', import.meta.url), 'utf8')
    const manifest = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as { engines: { dsh: { recommend: string } } }
    expect(RECOMMENDED_DSH_VERSION).toBe(manifest.engines.dsh.recommend)
  })
})

describe('install source repository mapping', () => {
  it('anchors the official repository at the verified org', () => {
    expect(OFFICIAL_INSTALL_REPO).toBe('https://github.com/deepseek-ai/deepseek-harness.git')
    expect(pkgRepoOf()).toBe(OFFICIAL_PKG_REPO)
    expect(pkgRepoOf('')).toBe(OFFICIAL_PKG_REPO)
    // The official anchor (and its legacy wrong-org spelling) map onto the packaging repo.
    expect(pkgRepoOf('https://github.com/deepseek-ai/deepseek-harness.git')).toBe(OFFICIAL_PKG_REPO)
    expect(pkgRepoOf('https://github.com/deepseek-harness/deepseek-harness.git')).toBe(OFFICIAL_PKG_REPO)
  })

  it('uses a configured fork or mirror as the release repository directly', () => {
    expect(pkgRepoOf('https://github.com/my-org/deepseek-harness-pkg')).toBe('my-org/deepseek-harness-pkg')
    expect(pkgRepoOf('https://github.com/my-org/deepseek-harness-pkg.git')).toBe('my-org/deepseek-harness-pkg')
    expect(pkgRepoOf('my-org/deepseek-harness-pkg')).toBe('my-org/deepseek-harness-pkg')
  })

  it('rejects unparseable repository strings onto the official source', () => {
    expect(pkgRepoOf('not a repo at all')).toBe(OFFICIAL_PKG_REPO)
  })

  it('parses GitHub URLs and bare owner/name pairs', () => {
    expect(parseGitHubRepo('https://github.com/a/b')).toBe('a/b')
    expect(parseGitHubRepo('http://github.com/a/b.git/')).toBe('a/b')
    expect(parseGitHubRepo('git@github.com:a/b')).toBeUndefined()
  })
})
