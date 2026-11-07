export interface BundleAsset {
  name: string
  url: string
  sha256: string
}

export interface BundleAssets {
  pnpm: BundleAsset
  dsh: BundleAsset
  git?: BundleAsset
}

export interface BundleConstants {
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

export function dshAssetName(platform: BundlePlatform, arch: BundleArch): string

export function dshArchiveName(platform: BundlePlatform, arch: BundleArch): string

export function mingitAssetName(arch: BundleArch, version: string): string

export function readBuildConstants(repo?: string): BundleConstants

export function bundleTargets(platform: BundlePlatform, options?: { withGit?: boolean }): string[]

export function bundleAssets(input: {
  platform: BundlePlatform
  arch: BundleArch
  constants: BundleConstants
  dshTag: string
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
