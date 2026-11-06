import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { applyBundleManifest, bundleAssets, dshArchiveName, dshAssetName, readBuildConstants, readManifest, resolveLatestStableDshTag, toAssetTable } from './bundle-metadata.mjs'

vi.mock('../packages/builtin-plugin-remote/src/host/service/gateway.auth.ts', () => ({ gatewayAuthHtml: async () => '' }))

it('loads remote build engine definitions from the repository manifest without building plugins', async () => {
  const { default: configure } = await import('../packages/builtin-plugin-remote/tsdown.config.ts')
  const [server] = await configure()
  const { dsh } = readManifest(fileURLToPath(new URL('../', import.meta.url))).engines
  expect(server.define.__REMOTE_DSH_MINIMUM__).toBe(JSON.stringify(dsh.minimum))
})

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const assetNames = [
  'deepseek-harness-pkg-windows.asar.zip',
  'deepseek-harness-pkg-windows-arm64.asar.zip',
  'deepseek-harness-pkg-linux.asar.zip',
  'deepseek-harness-pkg-linux-arm64.asar.zip',
  'deepseek-harness-pkg-macos-x64.asar.zip',
  'deepseek-harness-pkg-macos-arm64.asar.zip',
]

function release(tag_name, overrides = {}) {
  return {
    tag_name,
    draft: false,
    prerelease: false,
    assets: assetNames.map(name => ({ name, state: 'uploaded', digest: `sha256:${'a'.repeat(64)}` })),
    ...overrides,
  }
}

afterEach(() => vi.restoreAllMocks())

it('selects a 0.2.2 release with every supported asar asset instead of newer incompatible releases', async () => {
  const tag = await resolveLatestStableDshTag(async () => [
    release('dsh-0.3.0-110'),
    release('dsh-0.2.3-109'),
    release('dsh-0.2.2-beta.1-108'),
    release('dsh-0.2.2-rc.6-107', { draft: true }),
    release('dsh-0.2.2-rc.5-106', { prerelease: true }),
    release('dsh-0.2.2-rc.4-105', { assets: [] }),
    release('dsh-0.2.2-rc.3-104'),
    release('dsh-0.2.1-rc.5-103'),
  ])
  expect(tag).toBe('dsh-0.2.2-rc.3-104')
})

it.each(assetNames)('skips a release missing the %s asset', async (missing) => {
  const incomplete = release('dsh-0.2.2-rc.2-102')
  incomplete.assets = incomplete.assets.filter(asset => asset.name !== missing)
  await expect(resolveLatestStableDshTag(async () => [incomplete, release('dsh-0.2.2-rc.1-101')]))
    .resolves
    .toBe('dsh-0.2.2-rc.1-101')
})

it.each([
  { state: 'new' },
  { digest: null },
  { digest: 'sha256:invalid' },
])('skips releases whose asar cannot be verified: %j', async (override) => {
  const incomplete = release('dsh-0.2.2-rc.2-102')
  Object.assign(incomplete.assets[0], override)
  await expect(resolveLatestStableDshTag(async () => [incomplete, release('dsh-0.2.2-rc.1-101')]))
    .resolves
    .toBe('dsh-0.2.2-rc.1-101')
})

it.each(['dsh-0.2.2-100', 'dsh-0.2.2-rc.1-100'])('accepts supported stable tag %s', async (tag) => {
  await expect(resolveLatestStableDshTag(async () => [release(tag)])).resolves.toBe(tag)
})

it.each(['dsh-0.2.2-preview.1-100', 'dsh-0.2.2-alpha.1-100', 'dsh-0.2.2-rc.0-100', 'dsh-0.2.2-rc.1.preview-100', 'dsh-0.2.1-rc.5-100', 'dsh-0.2.3-100'])('rejects a release list containing only unsupported tag %s', async (tag) => {
  await expect(resolveLatestStableDshTag(async () => [release(tag)])).rejects.toThrow(/no stable 0\.2\.2.*asar/)
})

it('rejects malformed GitHub release responses', async () => {
  await expect(resolveLatestStableDshTag(async () => ({}))).rejects.toThrow(/not an array/)
})

it.each([
  ['windows', 'x64', 'deepseek-harness-pkg-windows'],
  ['windows', 'arm64', 'deepseek-harness-pkg-windows-arm64'],
  ['linux', 'x64', 'deepseek-harness-pkg-linux'],
  ['linux', 'arm64', 'deepseek-harness-pkg-linux-arm64'],
  ['macos', 'x64', 'deepseek-harness-pkg-macos-x64'],
  ['macos', 'arm64', 'deepseek-harness-pkg-macos-arm64'],
])('generates matching download and archive names for %s %s', (platform, arch, stem) => {
  expect(dshAssetName(platform, arch)).toBe(`${stem}.asar.zip`)
  expect(dshArchiveName(platform, arch)).toBe(`${stem}.asar`)
})

it('generates offline assets from current Electron build constants without standalone Node', () => {
  const assets = bundleAssets({ platform: 'windows', arch: 'arm64', constants: readBuildConstants(repoRoot), dshTag: 'dsh-0.2.2-rc.1-100', withGit: true })
  expect(Object.keys(assets)).toEqual(['pnpm', 'dsh', 'git'])
  expect(assets.dsh.url).toBe('https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/download/dsh-0.2.2-rc.1-100/deepseek-harness-pkg-windows-arm64.asar.zip')
  expect(assets.git.name).toBe('MinGit-2.53.0.2-arm64.zip')
})

it('rejects unsupported explicitly selected bundle tags', () => {
  expect(() => bundleAssets({ platform: 'linux', arch: 'x64', constants: readBuildConstants(repoRoot), dshTag: 'dsh-0.2.1-rc.5-100' }))
    .toThrow(/unsupported.*0\.2\.2/)
})

it('preserves the empty core digest field in the action asset table', () => {
  expect(toAssetTable({ dsh: { name: 'core.asar.zip', url: 'https://example.test/core.asar.zip', sha256: '' } }))
    .toBe('dsh|core.asar.zip|https://example.test/core.asar.zip|')
})

it.each([
  ['windows', false],
  ['windows', true],
  ['linux', true],
])('rewrites only bundled roots for %s with Git set to %s', (platform, withGit) => {
  const repo = mkdtempSync(path.join(tmpdir(), 'bundle-metadata-'))
  try {
    const resources = path.join(repo, 'apps/desktop/src-tauri/resources')
    mkdirSync(resources, { recursive: true })
    const file = path.join(resources, 'manifest.jsonc')
    writeFileSync(file, JSON.stringify({
      dependencies: { pnpm: {}, dsh: {}, git: { managedRoot: 'unchanged' } },
    }))
    expect(applyBundleManifest({ repo, platform, withGit }).file).toBe(file)
    expect(JSON.parse(readFileSync(file, 'utf8')).dependencies).toEqual({
      pnpm: { managedRoot: '$Resources/pnpm', overridable: false },
      dsh: { managedRoot: '$Resources/dsh', overridable: true },
      git: platform === 'windows' && withGit ? { managedRoot: '$Resources/git', overridable: false } : { managedRoot: 'unchanged' },
    })
  }
  finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
