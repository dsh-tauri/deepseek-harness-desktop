import { describe, expect, it } from 'vitest'
import * as bundleMetadataModule from '../scripts/bundle-metadata.mjs'

interface BundleAsset {
  name: string
  url: string
  sha256?: string
  sha256Url?: string
  version?: string
  tag?: string
}

interface BundleAssets {
  node: BundleAsset
  dsh: BundleAsset
  pnpm: BundleAsset
}

interface BundleConstants {
  nodeVersion: string
  pnpmVersion: string
  pnpmSha256: string
}

interface BundleMetadataModule {
  parseVersionFromTag: (tag: unknown) => string | null
  nodeAssetName: (platform: string, arch: string, version: string) => string
  dshAssetName: (platform: string, arch: string) => string
  bundleAssets: (input: {
    platform: string
    arch: string
    constants: BundleConstants
    dshVersion: string
    dshTag: string
  }) => BundleAssets
  toAssetTable: (assets: BundleAssets) => string
  readBuildConstants: (repo?: string) => BundleConstants
  readRecommendedDshVersion: (repo?: string) => string
  resolveDshRelease: (
    version: string,
    fetchJson?: (url: string) => Promise<unknown>,
  ) => Promise<{ tag: string, commit: string }>
}

const bundleMetadata = bundleMetadataModule as unknown as BundleMetadataModule

const constants: BundleConstants = {
  nodeVersion: '22.22.0',
  pnpmVersion: '11.7.0',
  pnpmSha256: 'a'.repeat(64),
}

describe('bundle metadata tag parsing', () => {
  it.each([
    ['dsh-0.1.0-rc.7-32054485373', '0.1.0-rc.7'],
    ['dsh-0.1.1-rc.2-32485170079', '0.1.1-rc.2'],
    ['src-0.1.2-alpha.1', '0.1.2-alpha.1'],
    ['dsh-src-0.1.2-alpha.1-33260039971', '0.1.2-alpha.1'],
  ])('parses %s', (tag, version) => {
    expect(bundleMetadata.parseVersionFromTag(tag)).toBe(version)
  })

  it.each(['dsh-0.2.0', '0.1.0-rc.7-abc', '', 'dsh-'])('rejects %s', (tag) => {
    expect(bundleMetadata.parseVersionFromTag(tag)).toBeNull()
  })
})

describe('bundle asset names', () => {
  it('mirrors the runtime node distribution layout', () => {
    expect(bundleMetadata.nodeAssetName('windows', 'x64', '22.22.0')).toBe('node-v22.22.0-win-x64.zip')
    expect(bundleMetadata.nodeAssetName('windows', 'arm64', '22.22.0')).toBe('node-v22.22.0-win-x64.zip')
    expect(bundleMetadata.nodeAssetName('macos', 'arm64', '22.22.0')).toBe('node-v22.22.0-darwin-arm64.tar.gz')
    expect(bundleMetadata.nodeAssetName('macos', 'x64', '22.22.0')).toBe('node-v22.22.0-darwin-x64.tar.gz')
    expect(bundleMetadata.nodeAssetName('linux', 'x64', '22.22.0')).toBe('node-v22.22.0-linux-x64.tar.gz')
    expect(bundleMetadata.nodeAssetName('linux', 'arm64', '22.22.0')).toBe('node-v22.22.0-linux-arm64.tar.gz')
  })

  it('mirrors the packaged core asset layout', () => {
    expect(bundleMetadata.dshAssetName('windows', 'x64')).toBe('deepseek-harness-pkg-windows.zip')
    expect(bundleMetadata.dshAssetName('linux', 'arm64')).toBe('deepseek-harness-pkg-linux.zip')
    expect(bundleMetadata.dshAssetName('macos', 'arm64')).toBe('deepseek-harness-pkg-macos-arm64.zip')
    expect(bundleMetadata.dshAssetName('macos', 'x64')).toBe('deepseek-harness-pkg-macos-x64.zip')
  })
})

describe('bundle asset resolution', () => {
  it('pins every windows asset to a downloadable url', () => {
    const assets = bundleMetadata.bundleAssets({
      platform: 'windows',
      arch: 'x64',
      constants,
      dshVersion: '0.1.5-rc.2',
      dshTag: 'dsh-0.1.5-rc.2-123',
    })

    expect(assets.node.url).toBe('https://nodejs.org/dist/v22.22.0/node-v22.22.0-win-x64.zip')
    expect(assets.node.sha256Url).toBe('https://nodejs.org/dist/v22.22.0/SHASUMS256.txt')
    expect(assets.dsh.url).toBe(
      'https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/download/dsh-0.1.5-rc.2-123/deepseek-harness-pkg-windows.zip',
    )
    expect(assets.pnpm.url).toBe('https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz')
  })

  // MinGit 不随离线包分发：资产列表必须始终只有 node / dsh / pnpm 三项。
  it.each([
    ['windows', 'x64'],
    ['macos', 'arm64'],
    ['macos', 'x64'],
    ['linux', 'x64'],
  ])('bundles exactly node, dsh and pnpm for %s/%s', (platform, arch) => {
    const assets = bundleMetadata.bundleAssets({
      platform,
      arch,
      constants,
      dshVersion: '0.1.5-rc.2',
      dshTag: 'dsh-0.1.5-rc.2-123',
    })
    expect(Object.keys(assets).sort()).toEqual(['dsh', 'node', 'pnpm'])
    const rows = bundleMetadata.toAssetTable(assets).split('\n')
    expect(rows.map(row => row.split('|')[0])).toEqual(['node', 'dsh', 'pnpm'])
    // 空字段必须如实保留（bash `read` 用 `|` 而不是 TAB 作为分隔符的原因）。
    expect(rows[0].split('|')[3]).toBe('')
    expect(rows[0].split('|')[4]).toBe(assets.node.sha256Url)
    expect(rows[2].split('|')[3]).toBe(constants.pnpmSha256)
    expect(rows[2].split('|')[4]).toBe('')
  })
})

describe('bundle release resolution', () => {
  it('picks the release whose tag parses to the recommended version', async () => {
    const release = await bundleMetadata.resolveDshRelease('0.1.5-rc.2', async () => [
      { tag_name: 'dsh-0.1.6-rc.1-200', target_commitish: 'main' },
      { tag_name: 'dsh-0.1.5-rc.2-123', target_commitish: '2'.repeat(40) },
    ])
    expect(release).toEqual({ tag: 'dsh-0.1.5-rc.2-123', commit: '2'.repeat(40) })
  })

  it('falls back to the tag build id when target_commitish is not a sha', async () => {
    const release = await bundleMetadata.resolveDshRelease('0.1.5-rc.2', async () => [
      { tag_name: 'dsh-0.1.5-rc.2-123', target_commitish: 'main' },
    ])
    expect(release).toEqual({ tag: 'dsh-0.1.5-rc.2-123', commit: '123' })
  })

  it('fails loudly when no release matches', async () => {
    await expect(bundleMetadata.resolveDshRelease('9.9.9', async () => [])).rejects.toThrow(
      /^BUNDLE_METADATA:/,
    )
  })
})

describe('bundle build constants', () => {
  it('reads node/pnpm pins from the checked out repository', () => {
    const parsed = bundleMetadata.readBuildConstants(process.cwd())
    expect(parsed.nodeVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(parsed.pnpmVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(parsed.pnpmSha256).toHaveLength(64)
    expect(bundleMetadata.readRecommendedDshVersion(process.cwd())).toMatch(/^\d+\.\d+\.\d+/)
  })
})
