/**
 * `scripts/bundle-metadata.mjs` 的类型声明。
 *
 * 该脚本是给 CI 直接调用的纯 ESM，本身不带类型；这里声明它导出的函数与常量，
 * 让 `test/bundle-metadata.test.ts` 的导入在 `pnpm typecheck` 下可解析。
 */

export interface BundleAsset {
  name: string
  url: string
  /** 构建期已知的固定摘要；需要单独下载摘要文件时为空字符串 */
  sha256: string
  /** 摘要文件地址（Node 官方 SHASUMS256.txt）；有固定摘要时为空字符串 */
  sha256Url: string
}

export interface BundleAssets {
  node: BundleAsset
  pnpm: BundleAsset
  dsh: BundleAsset
  /** 仅 Windows 随包（MinGit） */
  git?: BundleAsset
}

export interface BundleConstants {
  nodeVersion: string
  nodeBaseUrl: string
  pnpmVersion: string
  pnpmBaseUrl: string
  pnpmSha256: string
  mingitVersion: string
  mingitBaseUrl: string
  mingitX64Sha256: string
  mingitArm64Sha256: string
  dshCoreUrl: string
}

export type BundlePlatform = 'windows' | 'macos' | 'linux'
export type BundleArch = 'x64' | 'arm64'

export const BUNDLED_DIRS: Record<string, string>
export const DSH_PKG_REPO: string

export function stripJsonc(raw: string): string

export function readManifest(repo?: string): Record<string, unknown>

export function parseVersionFromTag(tag: unknown): string | null

export function nodeAssetName(platform: BundlePlatform, arch: BundleArch, version: string): string

export function dshAssetName(platform: BundlePlatform, arch: BundleArch): string

export function mingitAssetName(arch: BundleArch, version: string): string

export function readBuildConstants(repo?: string): BundleConstants

export function bundleTargets(platform: BundlePlatform, options?: { withGit?: boolean }): string[]

export function bundleAssets(input: {
  platform: BundlePlatform
  arch: BundleArch
  constants: BundleConstants
  dshTag: string
  /** 随包 MinGit（默认 false；Windows 且清单未被改写时才需要） */
  withGit?: boolean
}): BundleAssets

export function toAssetTable(assets: BundleAssets): string

export function applyBundleManifest(input: {
  repo?: string
  platform: BundlePlatform
  withGit?: boolean
}): { file: string, applied: string[] }

export function resolveLatestStableDshTag(
  fetchJson?: (url: string) => Promise<unknown>,
): Promise<string>
