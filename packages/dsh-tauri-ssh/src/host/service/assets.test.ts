import { describe, expect, it } from 'vitest'
import {
  assetMatrixFor,
  dshNpmTarballUrls,
  dshZipDownloadUrls,
  nodeDownloadUrls,
  nodeFilenameFor,
  nodeShasumUrls,
  parsePlatform,
  pnpmDownloadUrls,
  UnsupportedRemotePlatformError,
} from './assets'

describe('parsePlatform', () => {
  it('maps uname output onto repo identifiers (amd64/aarch64 aliases included)', () => {
    expect(parsePlatform('Linux 6.8.0-45-generic x86_64\n')).toEqual({ os: 'linux', arch: 'x64' })
    expect(parsePlatform('Linux 5.15 aarch64')).toEqual({ os: 'linux', arch: 'arm64' })
    expect(parsePlatform('Linux 6.1 amd64')).toEqual({ os: 'linux', arch: 'x64' })
    expect(parsePlatform('Darwin host.local 24.0 x86_64')).toEqual({ os: 'macos', arch: 'x64' })
  })

  it('rejects unsupported systems and architectures with the detected pair', () => {
    const unsupported = (out: string): UnsupportedRemotePlatformError => {
      try {
        parsePlatform(out)
      }
      catch (error) {
        if (error instanceof UnsupportedRemotePlatformError)
          return error
        throw error
      }
      throw new Error('expected a rejection')
    }
    expect(unsupported('MINGW64_NT-10.0 x86_64').detected).toEqual({ system: 'MINGW64_NT-10.0', machine: 'x86_64' })
    expect(unsupported('Linux 6.8 riscv64').detected).toEqual({ system: 'Linux', machine: 'riscv64' })
    expect(unsupported('Darwin host.local 24.0 arm64').message).toContain('macOS arm64')
    expect(unsupported('').message).toContain('REMOTE_PLATFORM_UNSUPPORTED')
  })
})

describe('assetMatrixFor', () => {
  it('linux x64 installs the packaged zip', () => {
    const matrix = assetMatrixFor('linux', 'x64')
    expect(matrix.dshKind).toBe('pkg-zip')
    expect(matrix.dshZipName).toBe('deepseek-harness-pkg-linux.zip')
    expect(matrix.nodeFilename).toBe('node-v22.22.0-linux-x64.tar.gz')
  })

  it('linux arm64 installs the npm tarball (no packaged arm64 zip exists)', () => {
    const matrix = assetMatrixFor('linux', 'arm64')
    expect(matrix.dshKind).toBe('npm-tgz')
    expect(matrix.dshNpmPackage).toBe('@deepseek-ai/dsh')
    expect(matrix.nodeFilename).toBe('node-v22.22.0-linux-arm64.tar.gz')
  })

  it('macos x64 installs the packaged zip', () => {
    const matrix = assetMatrixFor('macos', 'x64')
    expect(matrix.dshKind).toBe('pkg-zip')
    expect(matrix.dshZipName).toBe('deepseek-harness-pkg-macos-x64.zip')
    expect(matrix.nodeFilename).toBe('node-v22.22.0-darwin-x64.tar.gz')
  })

  it('rejects macOS arm64 and other unsupported combinations', () => {
    expect(() => assetMatrixFor('macos', 'arm64')).toThrow(UnsupportedRemotePlatformError)
    // Windows remotes: v1 limitation carried forward.
    expect(() => assetMatrixFor('windows' as 'linux', 'x64')).toThrow(UnsupportedRemotePlatformError)
    // Unknown architectures carry no Node asset; the matrix surfaces the typed error.
    expect(nodeFilenameFor('linux', 'riscv64' as 'arm64')).toBeUndefined()
  })
})

describe('download URL builders', () => {
  it('pairs every asset with its official source and mirror, in order', () => {
    expect(nodeDownloadUrls('linux', 'x64')).toEqual([
      'https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.gz',
      'https://npmmirror.com/mirrors/node/v22.22.0/node-v22.22.0-linux-x64.tar.gz',
    ])
    expect(nodeDownloadUrls('linux', 'arm64')).toEqual([
      'https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-arm64.tar.gz',
      'https://npmmirror.com/mirrors/node/v22.22.0/node-v22.22.0-linux-arm64.tar.gz',
    ])
    expect(nodeDownloadUrls('macos', 'x64')).toEqual([
      'https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-x64.tar.gz',
      'https://npmmirror.com/mirrors/node/v22.22.0/node-v22.22.0-darwin-x64.tar.gz',
    ])
    expect(nodeShasumUrls()[0]).toBe('https://nodejs.org/dist/v22.22.0/SHASUMS256.txt')
    expect(nodeShasumUrls()[1]).toContain('npmmirror.com')
    expect(pnpmDownloadUrls()).toEqual([
      'https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz',
      'https://registry.npmmirror.com/pnpm/-/pnpm-11.7.0.tgz',
    ])
  })

  it('builds the packaged zip URL pair (GitHub official → ghfast.top mirror)', () => {
    expect(dshZipDownloadUrls('dsh-tauri-desk/deepseek-harness-pkg', 'dsh-0.1.2-rc.1-1', 'deepseek-harness-pkg-linux.zip')).toEqual([
      'https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/download/dsh-0.1.2-rc.1-1/deepseek-harness-pkg-linux.zip',
      'https://ghfast.top/https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/download/dsh-0.1.2-rc.1-1/deepseek-harness-pkg-linux.zip',
    ])
  })

  it('builds the npm tarball URL pair for the arm64 kind', () => {
    expect(dshNpmTarballUrls('@deepseek-ai/dsh', '0.1.2-rc.1')).toEqual([
      'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz',
      'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz',
    ])
  })
})
