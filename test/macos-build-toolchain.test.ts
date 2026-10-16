import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readSource } from './setup/read-source'

const WORKFLOWS = [
  ['.github/workflows/build-bundle-macos.yml', 'steps.check.outputs.should_run == \'true\'', './.github/actions/setup-xcode'],
  ['.github/workflows/build-macos.yml', 'steps.check.outputs.should_run == \'true\'', './.github/actions/setup-xcode'],
  ['.github/workflows/build-test.yml', undefined, './.github/actions/setup-xcode'],
  ['.github/workflows/ci.yml', 'runner.os == \'macOS\'', './.github/actions/setup-xcode'],
] as const

const ACTION = readSource('.github/actions/setup-xcode/action.yml')
const verification = ACTION.split('      run: |\n')[1]?.replace(/^ {8}/gm, '')
const scratchRoot = fileURLToPath(new URL('../.temp/', import.meta.url))

function verifyToolchain(version: string, developerExit = 0): { status: number | null, exported: string } {
  mkdirSync(scratchRoot, { recursive: true })
  const root = mkdtempSync(join(scratchRoot, 'xcode-test-'))
  const envFile = join(root, 'env')
  try {
    const result = spawnSync('bash', ['-c', `
      xcrun() { printf '%s\\n' "$TEST_SWIFT_VERSION"; }
      xcode-select() { printf '%s\\n' '/Applications/Xcode_26.0.app/Contents/Developer'; return "$TEST_DEVELOPER_EXIT"; }
      ${verification}
    `], {
      stdio: 'ignore',
      timeout: 10000,
      env: { ...process.env, TEST_SWIFT_VERSION: version, TEST_DEVELOPER_EXIT: String(developerExit), GITHUB_ENV: envFile.replace(/\\/g, '/') },
    })
    expect(result.error).toBeUndefined()
    return { status: result.status, exported: result.status === 0 ? readFileSync(envFile, 'utf8') : '' }
  }
  finally {
    expect(resolve(root).startsWith(resolve(scratchRoot) + (process.platform === 'win32' ? '\\' : '/'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
}

describe('macOS packaging toolchain selection', () => {
  it('selects a stable Xcode without constraining its major version', () => {
    expect(ACTION).toContain('uses: maxim-lobanov/setup-xcode@ed7a3b1fda3918c0306d1b724322adc0b8cc0a90')
    expect(ACTION).toContain('xcode-version: latest-stable')
    expect(verification).toBeTypeOf('string')
  })

  it.each(['Apple Swift version 6.0 (swiftlang-6.0)', 'Apple Swift version 6.2.3 (swiftlang-6.2.3)', 'Swift version 7.0-dev'])('accepts %s and exports the selected toolchain runtime', (version) => {
    expect(verifyToolchain(version)).toEqual({
      status: 0,
      exported: 'DYLD_FALLBACK_LIBRARY_PATH=/Applications/Xcode_26.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx:/usr/lib/swift\n',
    })
  })

  it.each(['Apple Swift version 5.10', 'unexpected compiler output', ''])('rejects unsupported or unrecognized Swift output: %s', (version) => {
    expect(verifyToolchain(version)).toEqual({ status: 1, exported: '' })
  })

  it('fails when the selected developer directory cannot be read', () => {
    expect(verifyToolchain('Apple Swift version 6.2', 2)).toEqual({ status: 2, exported: '' })
  })

  it.each(WORKFLOWS)('%s selects the shared toolchain from the correct commit with its original platform gate', (path, condition, action) => {
    const source = readSource(path)
    const step = source.match(/ {6}- name: Setup Xcode\n([\s\S]*?)(?=\n {6}- |$)/)?.[1]
    expect(step, path).toBeTypeOf('string')
    expect(step, path).toContain(`uses: ${action}`)
    if (condition)
      expect(step, path).toContain(`if: ${condition}`)
    expect(source, path).not.toContain('/Applications/Xcode_16')
    expect(source, path).not.toContain('xcode-select -s')
  })
})
