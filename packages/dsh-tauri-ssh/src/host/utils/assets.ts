export type RemoteOs = 'linux' | 'macos'

export type RemoteArch = 'x64' | 'arm64'

export type DshAssetKind = 'pkg-zip' | 'npm-tgz'

export interface RemoteAssetMatrix {
  os: RemoteOs
  arch: RemoteArch
  dshKind: DshAssetKind
  nodeFilename: string
  dshZipName?: string
  dshNpmPackage?: string
}

export class UnsupportedRemotePlatformError extends Error {
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

export function parsePlatform(unameOut: string): { os: RemoteOs, arch: RemoteArch } {
  const parts = unameOut.trim().split(/\s+/u)
  const system = parts[0] ?? ''
  const machine = parts.length > 1 ? parts[parts.length - 1] ?? '' : ''
  const os: RemoteOs | undefined = system === 'Linux' ? 'linux' : system === 'Darwin' ? 'macos' : undefined
  const arch: RemoteArch | undefined = machine === 'x86_64' || machine === 'amd64'
    ? 'x64'
    : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : undefined
  if (os === undefined || arch === undefined || (os === 'macos' && arch === 'arm64'))
    throw new UnsupportedRemotePlatformError(system, machine)
  return { os, arch }
}

export function assetMatrixFor(os: RemoteOs, arch: RemoteArch): RemoteAssetMatrix {
  const nodeFilename = nodeFilenameFor(os, arch)
  if (nodeFilename === undefined)
    throw new UnsupportedRemotePlatformError(os, arch)
  if (os === 'linux' && arch === 'x64') {
    return { os, arch, dshKind: 'pkg-zip', nodeFilename, dshZipName: 'deepseek-harness-pkg-linux.zip' }
  }
  if (os === 'linux' && arch === 'arm64') {
    return { os, arch, dshKind: 'npm-tgz', nodeFilename, dshNpmPackage: '@deepseek-ai/dsh' }
  }
  if (os === 'macos' && arch === 'x64') {
    return { os, arch, dshKind: 'pkg-zip', nodeFilename, dshZipName: 'deepseek-harness-pkg-macos-x64.zip' }
  }
  throw new UnsupportedRemotePlatformError(os, arch)
}

export const NODE_VERSION = 'v22.22.0'

export const NODE_BASE_URL = 'https://nodejs.org/dist/'

export const NODE_MIRROR_BASE_URL = 'https://npmmirror.com/mirrors/node/'

export const PNPM_VERSION = '11.7.0'

export const PNPM_SHA256 = 'deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee'

export const PNPM_BASE_URL = 'https://registry.npmjs.org/pnpm/-/'

export const PNPM_MIRROR_BASE_URL = 'https://registry.npmmirror.com/pnpm/-/'

export const NPM_REGISTRY_BASES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'] as const

export function nodeFilenameFor(os: RemoteOs, arch: RemoteArch): string | undefined {
  if (os === 'linux' && arch === 'x64')
    return `node-${NODE_VERSION}-linux-x64.tar.gz`
  if (os === 'linux' && arch === 'arm64')
    return `node-${NODE_VERSION}-linux-arm64.tar.gz`
  if (os === 'macos' && arch === 'x64')
    return `node-${NODE_VERSION}-darwin-x64.tar.gz`
  return undefined
}
export function nodeDownloadUrls(os: RemoteOs, arch: RemoteArch): string[] {
  const filename = nodeFilenameFor(os, arch)
  if (filename === undefined)
    throw new UnsupportedRemotePlatformError(os, arch)
  return [
    `${NODE_BASE_URL}${NODE_VERSION}/${filename}`,
    `${NODE_MIRROR_BASE_URL}${NODE_VERSION}/${filename}`,
  ]
}

export function nodeShasumUrls(): string[] {
  return [
    `${NODE_BASE_URL}${NODE_VERSION}/SHASUMS256.txt`,
    `${NODE_MIRROR_BASE_URL}${NODE_VERSION}/SHASUMS256.txt`,
  ]
}

/**
 * v22.22.0 官方 SHASUMS256.txt 的 SHA-256。
 *
 * 清单本身也要过摘要校验：镜像（npmmirror）提供的清单只有在与官方逐字节
 * 相同时才被接受，否则归档源兜底会把「镜像改过的运行时 + 镜像改过的清单」
 * 当成一次合法安装。升级 NODE_VERSION 时必须同步更新本常量。
 */
export const NODE_SHASUMS256_SHA256 = '782c13291346fa7b5ac3ce3d6f0a466a1c9c317a30471a3f65f9ab7f6f7156c0'

export function pnpmDownloadUrls(): string[] {
  return [
    `${PNPM_BASE_URL}pnpm-${PNPM_VERSION}.tgz`,
    `${PNPM_MIRROR_BASE_URL}pnpm-${PNPM_VERSION}.tgz`,
  ]
}

/** GitHub Release 代理镜像前缀（与桌面端 config::DSH_MIRROR_PREFIXES 保持同一份清单） */
export const DSH_MIRROR_PREFIXES = [
  'https://gh-proxy.com/',
  'https://gh.llkk.cc/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
] as const

export function dshZipDownloadUrls(repo: string, tag: string, assetName: string): string[] {
  const official = `https://github.com/${repo}/releases/download/${tag}/${assetName}`
  return [official, ...DSH_MIRROR_PREFIXES.map(prefix => `${prefix}${official}`)]
}

export function dshNpmTarballUrls(packageName: string, version: string): string[] {
  return NPM_REGISTRY_BASES.map(base => `${base}/${packageName}/-/${packageName.split('/')[1]}-${version}.tgz`)
}
