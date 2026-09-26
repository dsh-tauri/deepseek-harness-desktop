/**
 * The remote install asset matrix: `uname` output → platform identifiers, the
 * per-platform choice of the three install assets (Node runtime, DSH
 * distribution, pnpm), and their official → mirror download URL pairs. Pure
 * functions over injectable constants so the matrix is fully unit-testable
 * without touching the network.
 *
 * DSH ships two distribution kinds: the packaged zip (a `pnpm deploy` tree
 * with platform-pinned native modules — only linux x64 and macOS x64 assets
 * exist) and the npm tarball of `@deepseek-ai/dsh` (assembled on the remote
 * by `pnpm install`, which resolves the correct platform natives — the only
 * honest asset for linux arm64, where no packaged zip exists).
 * @module dsh-tauri-ssh/host/service/assets
 */

/** Remote platform identifiers the install matrix understands. */
export type RemoteOs = 'linux' | 'macos'

/** Remote CPU architectures the install matrix understands. */
export type RemoteArch = 'x64' | 'arm64'

/** How the DSH distribution is fetched and laid out for one platform. */
export type DshAssetKind = 'pkg-zip' | 'npm-tgz'

/** One supported matrix cell. */
export interface RemoteAssetMatrix {
  os: RemoteOs
  arch: RemoteArch
  /** The DSH distribution kind this platform installs. */
  dshKind: DshAssetKind
  /** Node.js distribution tarball file name (under `<base>/<version>/`). */
  nodeFilename: string
  /** The packaged DSH zip asset name, when `dshKind` is `pkg-zip`. */
  dshZipName?: string
  /** The npm package the `npm-tgz` kind installs. */
  dshNpmPackage?: string
}

/** Typed failure for a remote platform outside the install matrix. */
export class UnsupportedRemotePlatformError extends Error {
  /** The raw `uname -srm` parts as detected (first column, last column). */
  readonly detected: { system: string, machine: string }

  constructor(system: string, machine: string) {
    super(
      `REMOTE_PLATFORM_UNSUPPORTED: 不支持远端系统/架构 ${system}/${machine}`
      + '（支持矩阵：linux x64、linux arm64、macOS x64；远端 Windows 与 macOS arm64 明确不支持）',
    )
    this.name = 'UnsupportedRemotePlatformError'
    this.detected = { system, machine }
  }
}

/**
 * Parse `uname -srm` output into the platform identifiers. Output looks like
 * `Linux 6.8.0-45-generic x86_64` / `Darwin host.local 24.0 arm64`: the
 * system name is the first column, the machine architecture the last.
 * @param unameOut - the raw `uname -srm` stdout.
 * @returns the supported (os, arch) pair.
 * @throws {UnsupportedRemotePlatformError} for anything outside the matrix.
 */
export function parsePlatform(unameOut: string): { os: RemoteOs, arch: RemoteArch } {
  const parts = unameOut.trim().split(/\s+/u)
  const system = parts[0] ?? ''
  const machine = parts.length > 1 ? parts[parts.length - 1] ?? '' : ''
  const os: RemoteOs | undefined = system === 'Linux' ? 'linux' : system === 'Darwin' ? 'macos' : undefined
  const arch: RemoteArch | undefined = machine === 'x86_64' || machine === 'amd64'
    ? 'x64'
    : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : undefined
  // macOS arm64 remotes are deliberately out of scope (spec S2): the matrix
  // stops at the three combinations the distribution actually covers.
  if (os === undefined || arch === undefined || (os === 'macos' && arch === 'arm64'))
    throw new UnsupportedRemotePlatformError(system, machine)
  return { os, arch }
}

/**
 * The asset matrix cell for one supported platform.
 * @param os - the remote operating system.
 * @param arch - the remote CPU architecture.
 * @returns the matrix entry (asset names; URLs are built by the dedicated
 * builders).
 * @throws {UnsupportedRemotePlatformError} for combinations outside the
 * matrix (Windows, macOS arm64, other architectures).
 */
export function assetMatrixFor(os: RemoteOs, arch: RemoteArch): RemoteAssetMatrix {
  const nodeFilename = nodeFilenameFor(os, arch)
  if (nodeFilename === undefined)
    throw new UnsupportedRemotePlatformError(os, arch)
  if (os === 'linux' && arch === 'x64') {
    return { os, arch, dshKind: 'pkg-zip', nodeFilename, dshZipName: 'deepseek-harness-pkg-linux.zip' }
  }
  if (os === 'linux' && arch === 'arm64') {
    // No packaged arm64 zip exists (the zips carry x64-pinned natives);
    // the npm tarball lets the remote resolve arm64 natives itself.
    return { os, arch, dshKind: 'npm-tgz', nodeFilename, dshNpmPackage: '@deepseek-ai/dsh' }
  }
  if (os === 'macos' && arch === 'x64') {
    return { os, arch, dshKind: 'pkg-zip', nodeFilename, dshZipName: 'deepseek-harness-pkg-macos-x64.zip' }
  }
  throw new UnsupportedRemotePlatformError(os, arch)
}

/** Bundled Node.js runtime line (satisfies DSH's `^22.19.0 || >=24` engine). */
export const NODE_VERSION = 'v22.22.0'

/** Node.js official distribution base. */
export const NODE_BASE_URL = 'https://nodejs.org/dist/'

/** Node.js mirror base (npmmirror; domestic fallback). */
export const NODE_MIRROR_BASE_URL = 'https://npmmirror.com/mirrors/node/'

/** pnpm version, aligned with the packaged distribution's `packageManager`. */
export const PNPM_VERSION = '11.7.0'

/** pnpm npm tarball SHA-256; must be updated together with the version. */
export const PNPM_SHA256 = 'deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee'

/** pnpm official npm registry tarball base. */
export const PNPM_BASE_URL = 'https://registry.npmjs.org/pnpm/-/'

/** pnpm mirror (npmmirror registry) tarball base. */
export const PNPM_MIRROR_BASE_URL = 'https://registry.npmmirror.com/pnpm/-/'

/** npm registry bases for the `npm-tgz` DSH kind (official → mirror). */
export const NPM_REGISTRY_BASES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'] as const

/** The Node.js tarball file name for one platform, when supported. */
export function nodeFilenameFor(os: RemoteOs, arch: RemoteArch): string | undefined {
  if (os === 'linux' && arch === 'x64')
    return `node-${NODE_VERSION}-linux-x64.tar.gz`
  if (os === 'linux' && arch === 'arm64')
    return `node-${NODE_VERSION}-linux-arm64.tar.gz`
  if (os === 'macos' && arch === 'x64')
    return `node-${NODE_VERSION}-darwin-x64.tar.gz`
  return undefined
}
/**
 * The Node.js tarball download URLs (official → mirror), in fallback order.
 * @param os - the remote operating system.
 * @param arch - the remote CPU architecture.
 */
export function nodeDownloadUrls(os: RemoteOs, arch: RemoteArch): string[] {
  const filename = nodeFilenameFor(os, arch)
  if (filename === undefined)
    throw new UnsupportedRemotePlatformError(os, arch)
  return [
    `${NODE_BASE_URL}${NODE_VERSION}/${filename}`,
    `${NODE_MIRROR_BASE_URL}${NODE_VERSION}/${filename}`,
  ]
}

/** The Node.js `SHASUMS256.txt` URLs (official → mirror). */
export function nodeShasumUrls(): string[] {
  return [
    `${NODE_BASE_URL}${NODE_VERSION}/SHASUMS256.txt`,
    `${NODE_MIRROR_BASE_URL}${NODE_VERSION}/SHASUMS256.txt`,
  ]
}

/** The pnpm tarball download URLs (official registry → mirror). */
export function pnpmDownloadUrls(): string[] {
  return [
    `${PNPM_BASE_URL}pnpm-${PNPM_VERSION}.tgz`,
    `${PNPM_MIRROR_BASE_URL}pnpm-${PNPM_VERSION}.tgz`,
  ]
}

/**
 * The packaged DSH zip download URLs (GitHub official → ghfast.top mirror)
 * for one release tag.
 * @param repo - the GitHub `owner/name` hosting the packaged releases.
 * @param tag - the release tag.
 * @param assetName - the platform zip asset name.
 */
export function dshZipDownloadUrls(repo: string, tag: string, assetName: string): string[] {
  const official = `https://github.com/${repo}/releases/download/${tag}/${assetName}`
  return [official, `https://ghfast.top/${official}`]
}

/**
 * The `@deepseek-ai/dsh` npm tarball URLs (official registry → mirror) for
 * one version. The packument's `dist.tarball` URL shape is deterministic.
 * @param packageName - the scoped npm package name.
 * @param version - the resolved package version.
 */
export function dshNpmTarballUrls(packageName: string, version: string): string[] {
  return NPM_REGISTRY_BASES.map(base => `${base}/${packageName}/-/${packageName.split('/')[1]}-${version}.tgz`)
}
