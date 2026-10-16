import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as bundleMetadata from '../scripts/bundle-metadata.mjs'

// 类型来自随脚本发布的 `bundle-metadata.d.mts`，测试不再另抄一份接口
// （抄一份的代价：脚本签名一变，用例仍在旧接口上编译通过）。
type BundlePlatform = 'windows' | 'macos' | 'linux'
type BundleArch = 'x64' | 'arm64'

const constants = {
  nodeVersion: '22.22.0',
  nodeBaseUrl: 'https://nodejs.org/dist/',
  pnpmVersion: '11.7.0',
  pnpmBaseUrl: 'https://registry.npmjs.org/pnpm/-/',
  pnpmSha256: 'a'.repeat(64),
  mingitVersion: '2.53.0.2',
  mingitBaseUrl: 'https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.2/',
  mingitX64Sha256: 'b'.repeat(64),
  mingitArm64Sha256: 'c'.repeat(64),
  dshCoreUrl: 'https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/latest/download/',
}

const DSH_TAG = 'dsh-0.1.5-rc.3-12345678901'

function assetsFor(platform: BundlePlatform, arch: BundleArch, options: { withGit?: boolean } = {}) {
  return bundleMetadata.bundleAssets({ platform, arch, constants, dshTag: DSH_TAG, ...options })
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
    expect(bundleMetadata.dshAssetName('linux', 'x64')).toBe('deepseek-harness-pkg-linux.zip')
    expect(bundleMetadata.dshAssetName('linux', 'arm64')).toBe('deepseek-harness-pkg-linux-arm64.zip')
    expect(bundleMetadata.dshAssetName('macos', 'arm64')).toBe('deepseek-harness-pkg-macos-arm64.zip')
    expect(bundleMetadata.dshAssetName('macos', 'x64')).toBe('deepseek-harness-pkg-macos-x64.zip')
  })

  it('mirrors the MinGit asset layout and rejects unknown architectures', () => {
    expect(bundleMetadata.mingitAssetName('x64', '2.53.0.2')).toBe('MinGit-2.53.0.2-64-bit.zip')
    expect(bundleMetadata.mingitAssetName('arm64', '2.53.0.2')).toBe('MinGit-2.53.0.2-arm64.zip')
    // 平台/架构来自 workflow 输入，运行期必须对未知值报错，而不是静默拼一个资产名。
    expect(() => bundleMetadata.mingitAssetName('ia32' as BundleArch, '2.53.0.2')).toThrow(/^BUNDLE_METADATA:/)
  })
})

describe('bundle asset resolution', () => {
  it('pins every essentials asset to a downloadable url', () => {
    const assets = assetsFor('windows', 'x64')

    expect(assets.node.url).toBe('https://nodejs.org/dist/v22.22.0/node-v22.22.0-win-x64.zip')
    expect(assets.node.sha256Url).toBe('https://nodejs.org/dist/v22.22.0/SHASUMS256.txt')
    expect(assets.dsh.url).toBe(
      `https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/download/${DSH_TAG}/deepseek-harness-pkg-windows.zip`,
    )
    expect(assets.pnpm.url).toBe('https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz')
  })

  it('bundles MinGit only on request, and only on windows', () => {
    // 启动 dsh 不需要 Git：默认只随包必要品。
    expect(bundleMetadata.bundleTargets('windows')).toEqual(['node', 'pnpm', 'dsh'])
    expect(bundleMetadata.bundleTargets('macos')).toEqual(['node', 'pnpm', 'dsh'])
    expect(Object.keys(assetsFor('windows', 'x64')).sort()).toEqual(['dsh', 'node', 'pnpm'])
    expect(Object.keys(assetsFor('macos', 'arm64')).sort()).toEqual(['dsh', 'node', 'pnpm'])

    const withGit = assetsFor('windows', 'x64', { withGit: true })
    expect(bundleMetadata.bundleTargets('windows', { withGit: true })).toEqual(['node', 'pnpm', 'dsh', 'git'])
    expect(withGit.git?.url).toBe(
      'https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.2/MinGit-2.53.0.2-64-bit.zip',
    )
    expect(withGit.git?.sha256).toBe(constants.mingitX64Sha256)
    expect(assetsFor('windows', 'arm64', { withGit: true }).git?.sha256).toBe(constants.mingitArm64Sha256)
    // 非 Windows 平台没有 MinGit 可选。
    expect(Object.keys(assetsFor('linux', 'x64', { withGit: true })).sort()).toEqual(['dsh', 'node', 'pnpm'])
  })

  it('keeps empty sha256 fields in the asset table', () => {
    const assets = assetsFor('linux', 'x64')
    const rows = bundleMetadata.toAssetTable(assets).split('\n')
    expect(rows.map(row => row.split('|')[0])).toEqual(['node', 'pnpm', 'dsh'])
    const field = (key: string, index: number) =>
      rows.find(row => row.startsWith(`${key}|`))!.split('|')[index]
    // 空字段必须如实保留（bash `read` 用 `|` 而不是 TAB 作为分隔符的原因）。
    expect(field('node', 3)).toBe('')
    expect(field('node', 4)).toBe(assets.node.sha256Url)
    expect(field('pnpm', 3)).toBe(constants.pnpmSha256)
    expect(field('pnpm', 4)).toBe('')
    expect(field('dsh', 3)).toBe('')
    expect(field('dsh', 4)).toBe('')
  })
})

describe('bundle release resolution', () => {
  it('picks the release whose tag parses to the recommended version', () => {
    expect(bundleMetadata.findReleaseTag([
      { tag_name: 'dsh-0.1.6-rc.1-200' },
      { tag_name: DSH_TAG },
    ], '0.1.5-rc.3')).toBe(DSH_TAG)
  })

  it('fails loudly when no release matches', () => {
    expect(() => bundleMetadata.findReleaseTag([], '9.9.9')).toThrow(/^BUNDLE_METADATA:/)
  })

  it('resolves the tag through the GitHub releases API', async () => {
    const tag = await bundleMetadata.resolveDshTag('0.1.5-rc.3', async () => [
      { tag_name: 'dsh-0.1.7-rc.1-35871708301' },
      { tag_name: DSH_TAG },
    ])
    expect(tag).toBe(DSH_TAG)
  })
})

describe('bundle build constants', () => {
  it('reads the node/pnpm/MinGit pins and the recommended core from the checkout', () => {
    const parsed = bundleMetadata.readBuildConstants(process.cwd())
    expect(parsed.nodeVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(parsed.nodeBaseUrl).toMatch(/^https:\/\//)
    expect(parsed.pnpmVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(parsed.pnpmSha256).toHaveLength(64)
    expect(parsed.mingitX64Sha256).toHaveLength(64)
    expect(parsed.dshCoreUrl).toContain('deepseek-harness-pkg')
    expect(bundleMetadata.readRecommendedDshVersion(process.cwd())).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('jsonc stripping', () => {
  it('tolerates comments and trailing commas without touching string content', () => {
    const raw = `{
      // 行注释
      "id": "a//b/*c*/",
      /* 块注释
         跨行 */
      "list": [1, 2,],
    }`
    expect(JSON.parse(bundleMetadata.stripJsonc(raw))).toEqual({
      id: 'a//b/*c*/',
      list: [1, 2],
    })
  })
})

describe('bundle manifest rewrite', () => {
  const SHIPPED = `{
  // 依赖映射规范
  "engines": { "dsh": { "recommend": "0.1.5-rc.3", "minimum": "0.1.5-rc.1" } },
  "dependencies": {
    "node": { "entry": "node.exe", "managedRoot": "$AppData/runtime", "overridable": true },
    "pnpm": { "entry": "bin/pnpm.cjs", "managedRoot": "$AppData/dependencies/pnpm", "overridable": true },
    "dsh": { "entry": "node_modules/@deepseek-ai/dsh/lib/bin.js", "managedRoot": "$AppData/dependencies/dsh", "overridable": true },
    "git": { "entry": { "windows": "cmd/git.exe", "default": "bin/git" }, "managedRoot": "$AppData/dependencies/git", "overridable": true }
  }
}`

  function tempRepo() {
    const repo = mkdtempSync(path.join(tmpdir(), 'dsh-bundle-manifest-'))
    mkdirSync(path.join(repo, 'src-tauri', 'resources'), { recursive: true })
    writeFileSync(path.join(repo, 'src-tauri', 'resources', 'manifest.jsonc'), SHIPPED, 'utf8')
    return repo
  }

  it('points every bundled dependency at $Resources and disables overrides', () => {
    const repo = tempRepo()
    try {
      const result = bundleMetadata.applyBundleManifest({ repo, platform: 'windows' })
      expect(result.applied).toEqual([
        'node -> $Resources/node (overridable: false)',
        'pnpm -> $Resources/pnpm (overridable: false)',
        'dsh -> $Resources/dsh (overridable: true)',
      ])

      const manifest = JSON.parse(readFileSync(result.file, 'utf8'))
      const shipped = JSON.parse(bundleMetadata.stripJsonc(SHIPPED))
      for (const [key, dir] of [['node', 'node'], ['pnpm', 'pnpm'], ['dsh', 'dsh']]) {
        expect(manifest.dependencies[key].managedRoot).toBe(`$Resources/${dir}`)
        // 内核保持可覆盖：核心面板要能把 dsh 根切到 AppData 里的其它版本再切回来。
        expect(manifest.dependencies[key].overridable).toBe(key === 'dsh')
        // 入口形状由清单声明，改写托管根不得动它。
        expect(manifest.dependencies[key].entry).toEqual(shipped.dependencies[key].entry)
      }
      expect(manifest.engines.dsh.recommend).toBe('0.1.5-rc.3')
      // 未随包的 git 保持清单原值：不能指向并不存在的 `$Resources/git`。
      expect(manifest.dependencies.git.managedRoot).toBe('$AppData/dependencies/git')
      expect(manifest.dependencies.git.overridable).toBe(true)
    }
    finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('moves git to $Resources only when MinGit is bundled', () => {
    const repo = tempRepo()
    try {
      const { file, applied } = bundleMetadata.applyBundleManifest({ repo, platform: 'windows', withGit: true })
      expect(applied).toEqual([
        'node -> $Resources/node (overridable: false)',
        'pnpm -> $Resources/pnpm (overridable: false)',
        'dsh -> $Resources/dsh (overridable: true)',
        'git -> $Resources/git (overridable: false)',
      ])
      const manifest = JSON.parse(readFileSync(file, 'utf8'))
      expect(manifest.dependencies.git.managedRoot).toBe('$Resources/git')
      expect(manifest.dependencies.git.overridable).toBe(false)
    }
    finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('leaves the non-Windows git mapping on app data', () => {
    const repo = tempRepo()
    try {
      const { file, applied } = bundleMetadata.applyBundleManifest({ repo, platform: 'macos' })
      expect(applied).toEqual([
        'node -> $Resources/node (overridable: false)',
        'pnpm -> $Resources/pnpm (overridable: false)',
        'dsh -> $Resources/dsh (overridable: true)',
      ])
      const manifest = JSON.parse(readFileSync(file, 'utf8'))
      expect(manifest.dependencies.git.managedRoot).toBe('$AppData/dependencies/git')
      expect(manifest.dependencies.git.overridable).toBe(true)
    }
    finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('is idempotent and fails loudly on unknown platforms', () => {
    const repo = tempRepo()
    try {
      bundleMetadata.applyBundleManifest({ repo, platform: 'linux' })
      const second = bundleMetadata.applyBundleManifest({ repo, platform: 'linux' })
      expect(second.applied).toEqual([
        'node -> $Resources/node (overridable: false)',
        'pnpm -> $Resources/pnpm (overridable: false)',
        'dsh -> $Resources/dsh (overridable: true)',
      ])
      expect(() => bundleMetadata.applyBundleManifest({ repo, platform: 'freebsd' as BundlePlatform }))
        .toThrow(/^BUNDLE_METADATA:/)
    }
    finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
