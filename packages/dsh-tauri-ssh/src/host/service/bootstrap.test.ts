import type { MachineProfile } from '../types/index'
import type { RemoteInstallPlan } from './bootstrap'
import type { SshExecOptions, SshExecResult, SshSession } from './transport'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { MachineId } from '../types/index'
import {
  buildInstallScript,
  bundleProbeCommand,
  checkMissingCommand,
  createBootstrapLineDispatcher,
  credentialsCopyCommand,
  describeExecFailure,
  ensurePnpmCommand,
  ensureRemoteInstance,
  firstLineOf,
  legacyProbeCommand,
  missingComponentsOf,
  normalizeNpmIntegrity,
  parseBootstrapLine,
  planRemoteInstall,
  readEnvCredentials,
  REMOTE_PROBE_NO_DOWNLOADER,
  REMOTE_ROOT,
  rootProbeCommand,
  skippedVerificationSummary,
  splitBundleProbeStdout,
  startCommandFor,
} from './bootstrap'

const profile: MachineProfile = {
  id: MachineId('m1'),
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  remotePort: 3080,
}

/** A realistic newest-first release list matching the live pkg repository. */
const RELEASES = [
  { tag: 'dsh-0.2.0-preview.1-32490000001', prerelease: true },
  { tag: 'dsh-0.1.5-rc.3-35833820356', prerelease: false },
  { tag: 'dsh-0.1.2-rc.1-33729514615', prerelease: false },
  { tag: 'dsh-0.1.1-rc.1-32342588166', prerelease: false },
]

const PKG_REPO = 'dsh-tauri-desk/deepseek-harness-pkg'

/** The GitHub assets the linux-x64 zip release carries. */
const LINUX_ASSETS = [
  {
    name: 'deepseek-harness-pkg-linux.zip',
    url: `https://github.com/${PKG_REPO}/releases/download/dsh-0.1.5-rc.3-35833820356/deepseek-harness-pkg-linux.zip`,
    digest: 'sha256:6b7ecfebe3b7d779b459262943b17777427860f1b96dbf3b6f16a5074b1119a7',
  },
]

/** The default injected fetchers (no network): a healthy metadata view. */
function healthyFetchers(overrides: Partial<{
  listReleases: () => Promise<typeof RELEASES>
  listAssets: () => Promise<typeof LINUX_ASSETS>
  npmDist: () => Promise<{ url: string, mirrorUrl: string, integrity?: string }>
}> = {}) {
  return {
    listReleases: () => Promise.resolve(RELEASES),
    listAssets: () => Promise.resolve(LINUX_ASSETS),
    npmDist: () => Promise.resolve({
      url: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz',
      mirrorUrl: 'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz',
      integrity: 'sha512-ZXhhZQ==',
    }),
    ...overrides,
  }
}

class FakeSession implements SshSession {
  commands: string[] = []

  constructor(private readonly responder: (command: string, index: number) => SshExecResult) {}

  exec(command: string, _options?: SshExecOptions): Promise<SshExecResult> {
    this.commands.push(command)
    return Promise.resolve(this.responder(command, this.commands.length - 1))
  }

  openTunnel(): Promise<never> {
    throw new Error('unused')
  }

  onClosed(): void {}

  close(): Promise<void> {
    return Promise.resolve()
  }
}

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-bootstrap-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseBootstrapLine', () => {
  it('splits stage-tagged markers and demotes untagged lines', () => {
    expect(parseBootstrapLine('::dsh download https://example.test/a')).toEqual({
      stage: 'download',
      line: 'https://example.test/a',
    })
    expect(parseBootstrapLine('::dsh failed checksum mismatch: x')).toEqual({
      stage: 'failed',
      line: 'checksum mismatch: x',
    })
    expect(parseBootstrapLine('random tool output')).toEqual({ stage: 'install', line: 'random tool output' })
  })

  it('demotes unknown stage words instead of leaking them into the typed channel', () => {
    expect(parseBootstrapLine('::dsh bogus hello')).toEqual({ stage: 'install', line: '::dsh bogus hello' })
    expect(parseBootstrapLine('::dsh 123 numbers')).toEqual({ stage: 'install', line: '::dsh 123 numbers' })
  })
})

describe('createBootstrapLineDispatcher', () => {
  it('holds a half-received line back until its newline completes it', () => {
    const lines: string[] = []
    const dispatch = createBootstrapLineDispatcher(line => lines.push(line))
    dispatch.push('::dsh verify 警告: 远端缺少摘要工具，跳过校')
    expect(lines).toEqual([])
    dispatch.push('验 node.tar.gz\n::dsh download https://a.test/x')
    expect(lines).toEqual(['::dsh verify 警告: 远端缺少摘要工具，跳过校验 node.tar.gz'])
    dispatch.push('\n')
    expect(lines).toEqual(['::dsh verify 警告: 远端缺少摘要工具，跳过校验 node.tar.gz', '::dsh download https://a.test/x'])
  })

  it('flushes a trailing unterminated line and drops empty lines', () => {
    const lines: string[] = []
    const dispatch = createBootstrapLineDispatcher(line => lines.push(line))
    dispatch.push('one\n\ntwo\n')
    dispatch.push('tail without newline')
    dispatch.flush()
    dispatch.flush()
    expect(lines).toEqual(['one', 'two', 'tail without newline'])
  })
})

describe('normalizeNpmIntegrity', () => {
  it('decodes SRI base64 digests into the script-verifiable hex form', () => {
    expect(normalizeNpmIntegrity('sha512-dQw4w9WgXcQ=')).toBe(`sha512:${Buffer.from('dQw4w9WgXcQ=', 'base64').toString('hex')}`)
    expect(normalizeNpmIntegrity('sha256-ZXhhZQ==')).toBe(`sha256:${Buffer.from('ZXhhZQ==', 'base64').toString('hex')}`)
  })

  it('passes colonformed digests through and drops unshaped ones', () => {
    expect(normalizeNpmIntegrity('sha512:deadbeef')).toBe('sha512:deadbeef')
    expect(normalizeNpmIntegrity(undefined)).toBeUndefined()
    expect(normalizeNpmIntegrity('md5-xxxx')).toBeUndefined()
    expect(normalizeNpmIntegrity('garbage')).toBeUndefined()
  })
})

describe('skippedVerificationSummary', () => {
  it('merges plan notes and streamed skip warnings, deduplicated', () => {
    expect(skippedVerificationSummary(
      ['未取得 @deepseek-ai/dsh@0.1.2 的完整性摘要，将跳过校验', 'release 列表获取失败（offline）'],
      ['警告: 未取得可信摘要，跳过校验 dsh.tgz'],
    )).toBe('；跳过校验项: 未取得 @deepseek-ai/dsh@0.1.2 的完整性摘要，将跳过校验；警告: 未取得可信摘要，跳过校验 dsh.tgz')
    expect(skippedVerificationSummary(
      ['警告: 远端缺少摘要工具，跳过校验 node.tar.gz'],
      ['警告: 远端缺少摘要工具，跳过校验 node.tar.gz'],
    )).toBe('；跳过校验项: 警告: 远端缺少摘要工具，跳过校验 node.tar.gz')
  })

  it('stays empty when everything was verified', () => {
    expect(skippedVerificationSummary(['版本选择: pin 直用'], [])).toBe('')
    expect(skippedVerificationSummary([], [])).toBe('')
  })
})

describe('planRemoteInstall', () => {
  it('pins the recommended release for linux x64 with its trusted digest', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    expect(plan.os).toBe('linux')
    expect(plan.arch).toBe('x64')
    expect(plan.dsh.kind).toBe('pkg-zip')
    if (plan.dsh.kind !== 'pkg-zip')
      throw new Error('expected pkg-zip')
    expect(plan.dsh.tag).toBe('dsh-0.1.5-rc.3-35833820356')
    expect(plan.dsh.digest).toBe(LINUX_ASSETS[0]?.digest)
    expect(plan.dsh.urls[0]).toBe(LINUX_ASSETS[0]?.url)
    expect(plan.dsh.urls[1]).toContain('ghfast.top/')
    expect(plan.dshEntry).toBe('node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(plan.dshVersion).toBe('0.1.5-rc.3')
    expect(plan.notes).toEqual([])
  })

  it('resolves the arm64 npm asset with its packument integrity', async () => {
    const plan = await planRemoteInstall('Linux 5.15 aarch64', {}, healthyFetchers())
    expect(plan.dsh.kind).toBe('npm-tgz')
    if (plan.dsh.kind === 'npm-tgz') {
      expect(plan.dsh.urls).toEqual([
        'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz',
        'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz',
      ])
      // The SRI digest arrives normalized into the script-verifiable hex form.
      expect(plan.dsh.integrity).toBe(`sha512:${Buffer.from('ZXhhZQ==', 'base64').toString('hex')}`)
    }
    expect(plan.dshEntry).toBe('lib/bin.js')
    expect(plan.node.urls[0]).toBe('https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-arm64.tar.gz')
  })

  it('derives deterministic URLs and notes skipped verification when metadata fails', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers({
      listAssets: () => Promise.reject(new Error('rate limited')),
    }))
    expect(plan.dsh.kind).toBe('pkg-zip')
    expect(plan.notes.join('\n')).toContain('资产元数据获取失败')
    expect(plan.notes.join('\n')).toContain('跳过 SHA-256 校验')
    if (plan.dsh.kind === 'pkg-zip')
      expect(plan.dsh.urls[0]).toBe(LINUX_ASSETS[0]?.url)
  })

  it('derives deterministic npm URLs when the registry view fails', async () => {
    const plan = await planRemoteInstall('Linux 5.15 aarch64', {}, healthyFetchers({
      npmDist: () => Promise.reject(new Error('offline')),
    }))
    expect(plan.dsh.kind).toBe('npm-tgz')
    if (plan.dsh.kind === 'npm-tgz')
      expect(plan.dsh.urls[0]).toBe('https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz')
    expect(plan.notes.join('\n')).toContain('未取得')
  })

  it('falls back to the known stable tag when the release listing fails', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers({
      listReleases: () => Promise.reject(new Error('offline')),
    }))
    if (plan.dsh.kind !== 'pkg-zip')
      throw new Error('expected pkg-zip')
    expect(plan.dsh.tag).toBe('dsh-0.1.5-rc.3-35833820356')
    expect(plan.notes.join('\n')).toContain('release 列表获取失败')
  })

  it('honors a configured pin and a custom release repository', async () => {
    const repos: string[] = []
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {
      installRepo: 'https://github.com/my-org/deepseek-harness-pkg.git',
      installRef: '0.1.1-rc.1',
    }, {
      listReleases: (repo) => {
        repos.push(repo)
        return Promise.resolve(RELEASES)
      },
      listAssets: () => Promise.resolve(LINUX_ASSETS),
      npmDist: () => Promise.reject(new Error('unused')),
    })
    expect(repos).toEqual(['my-org/deepseek-harness-pkg'])
    if (plan.dsh.kind !== 'pkg-zip')
      throw new Error('expected pkg-zip')
    expect(plan.dsh.tag).toBe('dsh-0.1.1-rc.1-32342588166')
  })

  it('rejects platforms outside the matrix before any network use', async () => {
    const fetchers = {
      listReleases: (): Promise<typeof RELEASES> => {
        throw new Error('must not be called')
      },
      listAssets: (): Promise<typeof LINUX_ASSETS> => {
        throw new Error('must not be called')
      },
      npmDist: (): Promise<never> => {
        throw new Error('must not be called')
      },
    }
    await expect(planRemoteInstall('MINGW64_NT-10.0-19045 x86_64', {}, fetchers)).rejects.toThrow(/REMOTE_PLATFORM_UNSUPPORTED/)
  })
})

describe('buildInstallScript', () => {
  it('embeds the plan: URLs, digests, entries, and the cleanup trap', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers())
    const script = buildInstallScript(plan)
    expect(script).toContain('https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.gz')
    expect(script).toContain('https://npmmirror.com/mirrors/node/v22.22.0/node-v22.22.0-linux-x64.tar.gz')
    expect(script).toContain('https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz')
    expect(script).toContain(LINUX_ASSETS[0]?.url ?? '')
    expect(script).toContain('sha256:6b7ecfebe3b7d779b459262943b17777427860f1b96dbf3b6f16a5074b1119a7')
    expect(script).toContain('trap cleanup EXIT')
    expect(script).toContain('checksum mismatch')
    expect(script).toContain('unzip -q -o')
    expect(script).not.toContain('pnpm install')
  })

  it('arm64: assembles node_modules on the remote with registry fallback', async () => {
    const plan = await planRemoteInstall('Linux 5.15 aarch64', {}, healthyFetchers())
    const script = buildInstallScript(plan)
    expect(script).toContain('https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz')
    expect(script).toContain(`sha512:${Buffer.from('ZXhhZQ==', 'base64').toString('hex')}`)
    expect(script).toContain('install --prod --silent --registry')
    expect(script).toContain('"$ROOT/dependencies/pnpm/bin/pnpm.cjs"')
    expect(script).toContain('https://registry.npmmirror.com')
    // pnpm must run inside the extracted package (SSH exec starts in $HOME,
    // where pnpm aborts with ERR_PNPM_NO_PKG_MANIFEST).
    expect(script).toContain('( cd "$ROOT/dependencies/dsh" && "$ROOT/runtime/bin/node"')
    // The tarball path extracts with tar; the zip helper stays uncalled.
    expect(script).not.toContain('extract_zip "$TMP/dsh')
  })

  it('notes an unparseable installRepo instead of silently installing official', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', { installRepo: 'not a repo at all' }, healthyFetchers())
    expect(plan.repo).toBe(PKG_REPO)
    expect(plan.notes.join('\n')).toContain('无法解析为 GitHub 仓库')
    expect(plan.notes.join('\n')).toContain(PKG_REPO)
  })

  it('dedupes the npm tarball URL pair when the packument already carries the mirror', async () => {
    const mirrorOnly = 'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz'
    const plan = await planRemoteInstall('Linux 5.15 aarch64', {}, healthyFetchers({
      npmDist: () => Promise.resolve({ url: mirrorOnly, mirrorUrl: mirrorOnly, integrity: 'sha512-ZXhhZQ==' }),
    }))
    if (plan.dsh.kind !== 'npm-tgz')
      throw new Error('expected npm-tgz')
    expect(plan.dsh.urls).toEqual([mirrorOnly])
  })
})

describe('install script execution (real POSIX sh)', () => {
  /**
   * Run one generated script under the real `sh` inside a sandboxed HOME,
   * with a fake `curl` first on PATH that "downloads" tampered bytes and a
   * SHASUMS256.txt pinning a digest those bytes cannot match.
   */
  function runScript(script: string, sandbox: string): Promise<{ code: number, stdout: string, stderr: string }> {
    const binDir = join(sandbox, 'fake-bin')
    mkdirSync(binDir, { recursive: true })
    const fakeCurl = join(binDir, 'curl')
    writeFileSync(fakeCurl, [
      '#!/bin/sh',
      'dst=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-o" ]; then dst="$arg"; fi',
      '  prev="$arg"',
      'done',
      'url=""',
      'for arg in "$@"; do url="$arg"; done',
      'case "$url" in',
      '  *SHASUMS256.txt)',
      '    printf \'%s  %s\\n\' deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef node-v22.22.0-linux-x64.tar.gz > "$dst"',
      '    ;;',
      '  *)',
      '    printf \'tampered-download-bytes\' > "$dst"',
      '    ;;',
      'esac',
      'exit 0',
    ].join('\n'))
    chmodSync(fakeCurl, 0o755)
    const scriptPath = join(sandbox, 'install.sh')
    writeFileSync(scriptPath, script)
    const run = promisify(execFile)
    return run('sh', [scriptPath], {
      env: { ...process.env, HOME: sandbox, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number, stdout?: string, stderr?: string }) =>
        ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
    )
  }

  it('aborts and cleans half-products when the SHA-256 mismatches (tampered asset)', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers({
      listAssets: () => Promise.resolve(LINUX_ASSETS),
    }))
    const sandbox = tempDir()
    const outcome = await runScript(buildInstallScript(plan), sandbox)
    // The node tarball's digest cannot match the tampered download: the run
    // must abort before installing anything and the trap must clean up.
    expect(outcome.code).toBe(11)
    expect(outcome.stdout).toContain('::dsh failed checksum mismatch')
    expect(existsSync(join(sandbox, REMOTE_ROOT, 'runtime'))).toBe(false)
    expect(existsSync(join(sandbox, REMOTE_ROOT, 'tmp'))).toBe(false)
    expect(existsSync(join(sandbox, REMOTE_ROOT, 'runtime.new'))).toBe(false)
    expect(existsSync(join(sandbox, REMOTE_ROOT, 'dependencies', 'dsh'))).toBe(false)
  })

  it('skips every section when the three components are already installed', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers())
    const sandbox = tempDir()
    const root = join(sandbox, REMOTE_ROOT)
    mkdirSync(join(root, 'runtime', 'bin'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'bin', 'node'), 'placeholder')
    chmodSync(join(root, 'runtime', 'bin', 'node'), 0o755)
    mkdirSync(join(root, 'dependencies', 'pnpm', 'bin'), { recursive: true })
    writeFileSync(join(root, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'), 'placeholder')
    mkdirSync(join(root, 'dependencies', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(join(root, 'dependencies', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'placeholder')
    const outcome = await runScript(buildInstallScript(plan), sandbox)
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('node 已就绪')
    expect(outcome.stdout).toContain('pnpm 已就绪')
    expect(outcome.stdout).toContain('dsh 已就绪')
    expect(outcome.stdout).toContain('远端初始化完成')
    expect(outcome.stdout).not.toContain('::dsh download')
    expect(existsSync(join(root, 'tmp'))).toBe(false)
  })

  /**
   * Run one generated script under the real `sh` inside a sandboxed HOME
   * whose fake `curl` serves crafted artifacts from `servedDir` by URL
   * basename. Used for the arm64 npm path, whose node/pnpm/dsh tarballs are
   * sh shims standing in for the real binaries.
   */
  function runScriptServing(script: string, sandbox: string, servedDir: string): Promise<{ code: number, stdout: string, stderr: string }> {
    const binDir = join(sandbox, 'fake-bin')
    mkdirSync(binDir, { recursive: true })
    const fakeCurl = join(binDir, 'curl')
    writeFileSync(fakeCurl, [
      '#!/bin/sh',
      'dst=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-o" ]; then dst="$arg"; fi',
      '  prev="$arg"',
      'done',
      'url=""',
      'for arg in "$@"; do url="$arg"; done',
      'if [ -f "$SERVED/$(basename "$url")" ]; then cp "$SERVED/$(basename "$url")" "$dst"; exit 0; fi',
      'echo "fake curl: no artifact for $url" >&2',
      'exit 22',
    ].join('\n'))
    chmodSync(fakeCurl, 0o755)
    const scriptPath = join(sandbox, 'install.sh')
    writeFileSync(scriptPath, script)
    const run = promisify(execFile)
    return run('sh', [scriptPath], {
      env: { ...process.env, HOME: sandbox, SERVED: servedDir, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number, stdout?: string, stderr?: string }) =>
        ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
    )
  }

  /**
   * arm64 (npm-tgz) execution coverage: the whole script runs under real sh
   * with crafted tarballs — node is an `exec sh` shim, pnpm.cjs a stand-in
   * that REFUSES to run without a package.json in cwd (exactly the
   * ERR_PNPM_NO_PKG_MANIFEST failure the missing `cd` would cause) and
   * writes a marker into node_modules when it "installs".
   */
  it('arm64: pnpm install runs inside the extracted package (real POSIX sh)', async () => {
    const work = tempDir()
    const served = join(work, 'served')
    mkdirSync(served, { recursive: true })

    // node dist: bin/node = a sh shim standing in for the real binary, plus
    // a second top-level entry so flatten_move sees the real multi-entry
    // layout (a lone bin/ would flatten one level too many).
    const nodeDir = join(work, 'node-v22.22.0-linux-arm64')
    mkdirSync(join(nodeDir, 'bin'), { recursive: true })
    mkdirSync(join(nodeDir, 'include'), { recursive: true })
    writeFileSync(join(nodeDir, 'bin', 'node'), '#!/bin/sh\nexec sh "$@"\n')
    chmodSync(join(nodeDir, 'bin', 'node'), 0o755)
    writeFileSync(join(nodeDir, 'include', 'node'), 'headers\n')
    const nodeTgz = join(served, 'node-v22.22.0-linux-arm64.tar.gz')
    await promisify(execFile)('tar', ['-czf', nodeTgz, '-C', work, 'node-v22.22.0-linux-arm64'])

    // pnpm dist: the cwd-gating stand-in, packed as package/{bin,lib}.
    const pnpmStage = join(work, 'pnpm-stage')
    mkdirSync(join(pnpmStage, 'package', 'bin'), { recursive: true })
    mkdirSync(join(pnpmStage, 'package', 'lib'), { recursive: true })
    writeFileSync(join(pnpmStage, 'package', 'bin', 'pnpm.cjs'), [
      '#!/bin/sh',
      'if [ ! -f package.json ]; then',
      '  echo "ERR_PNPM_NO_PKG_MANIFEST: no package.json in $PWD" >&2',
      '  exit 1',
      'fi',
      'mkdir -p node_modules',
      'echo ok > node_modules/installed',
    ].join('\n'))
    writeFileSync(join(pnpmStage, 'package', 'lib', 'pnpm.js'), 'module.exports = {}\n')
    const pnpmTgz = join(served, 'pnpm-11.7.0.tgz')
    await promisify(execFile)('tar', ['-czf', pnpmTgz, '-C', pnpmStage, 'package'])

    // dsh dist: the npm package layout (package.json + lib/bin.js).
    const dshStage = join(work, 'dsh-stage')
    mkdirSync(join(dshStage, 'package', 'lib'), { recursive: true })
    writeFileSync(join(dshStage, 'package', 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.1.2-rc.1"}\n')
    writeFileSync(join(dshStage, 'package', 'lib', 'bin.js'), '#!/usr/bin/env node\nvoid 0\n')
    const dshTgz = join(served, 'dsh-0.1.5-rc.3.tgz')
    await promisify(execFile)('tar', ['-czf', dshTgz, '-C', dshStage, 'package'])

    const digest = (file: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64') =>
      createHash(algorithm).update(readFileSync(file)).digest(encoding)
    writeFileSync(join(served, 'SHASUMS256.txt'), `${digest(nodeTgz, 'sha256', 'hex')}  node-v22.22.0-linux-arm64.tar.gz\n`)

    const basePlan = await planRemoteInstall('Linux 5.15 aarch64', {}, healthyFetchers({
      npmDist: () => Promise.resolve({
        url: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz',
        mirrorUrl: 'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz',
        // The real SRI form npm serves; the planner normalizes it to hex.
        integrity: `sha512-${digest(dshTgz, 'sha512', 'base64')}`,
      }),
    }))
    // The pinned pnpm digest is the real release's; point it at the crafted
    // tarball so the verify step passes against what the fake curl serves.
    const plan: RemoteInstallPlan = { ...basePlan, pnpm: { ...basePlan.pnpm, sha256: digest(pnpmTgz, 'sha256', 'hex') } }

    const sandbox = tempDir()
    const outcome = await runScriptServing(buildInstallScript(plan), sandbox, served)
    // Without the cd into dependencies/dsh, the pnpm stand-in aborts with
    // ERR_PNPM_NO_PKG_MANIFEST on both registries and the script exits 13.
    expect(outcome.stderr).toBe('')
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('dsh 依赖安装完成 (registry https://registry.npmjs.org)')
    expect(outcome.stdout).toContain('远端初始化完成')
    const root = join(sandbox, REMOTE_ROOT)
    expect(existsSync(join(root, 'dependencies', 'dsh', 'node_modules', 'installed'))).toBe(true)
    expect(existsSync(join(root, 'dependencies', 'dsh', 'lib', 'bin.js'))).toBe(true)
    expect(existsSync(join(root, 'runtime', 'bin', 'node'))).toBe(true)
    expect(existsSync(join(root, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'))).toBe(true)
  })
})

describe('remote pnpm shim (real POSIX sh)', () => {
  /** Run a generated command under the real `sh` inside a sandboxed HOME. */
  async function runCommand(command: string, sandbox: string): Promise<{ code: number, stdout: string, stderr: string }> {
    const scriptPath = join(sandbox, 'command.sh')
    writeFileSync(scriptPath, command)
    const run = promisify(execFile)
    return run('sh', [scriptPath], { env: { ...process.env, HOME: sandbox } }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number, stdout?: string, stderr?: string }) =>
        ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
    )
  }

  it('writes a shim that runs the layout pnpm under the layout node', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'pnpm-shim-'))
    try {
      const bin = join(sandbox, REMOTE_ROOT, 'runtime', 'bin')
      const entry = join(sandbox, REMOTE_ROOT, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
      mkdirSync(bin, { recursive: true })
      mkdirSync(join(sandbox, REMOTE_ROOT, 'dependencies', 'pnpm', 'bin'), { recursive: true })
      // 布局里的 node 与 pnpm 用桩件代替：断言垫片确实按「布局 node + 布局 pnpm」转发
      writeFileSync(join(bin, 'node'), `#!/bin/sh\nprintf 'node:%s\\n' "$*"\n`)
      chmodSync(join(bin, 'node'), 0o755)
      writeFileSync(entry, 'stub')

      const first = await runCommand(ensurePnpmCommand(), sandbox)
      expect(first.code).toBe(0)
      const shim = join(bin, 'pnpm')
      expect(existsSync(shim)).toBe(true)
      expect(statSync(shim).mode & 0o111).not.toBe(0)
      expect(readFileSync(shim, 'utf8')).toContain(`exec "$HOME/${REMOTE_ROOT}/runtime/bin/node" "$HOME/${REMOTE_ROOT}/dependencies/pnpm/bin/pnpm.cjs" "$@"`)

      // 垫片可执行，并按布局 node + 布局 pnpm 转发参数
      const forwarded = await runCommand(`"${shim}" install --prod`, sandbox)
      expect(forwarded.stdout).toContain(`node:${entry} install --prod`)

      // 幂等：已有垫片不再改写（改成哨兵内容后重跑，内容保持不变）
      writeFileSync(shim, '#!/bin/sh\necho sentinel\n')
      chmodSync(shim, 0o755)
      const second = await runCommand(ensurePnpmCommand(), sandbox)
      expect(second.code).toBe(0)
      expect(readFileSync(shim, 'utf8')).toContain('sentinel')
    }
    finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('component probe and launch commands', () => {
  it('lists the missing components of the remote layout', () => {
    const command = checkMissingCommand()
    expect(command).toContain('.dsh-desktop')
    expect(command).toContain('"$ROOT/runtime/bin/node"')
    expect(command).toContain('"$ROOT/dependencies/pnpm/bin/pnpm.cjs"')
    expect(command).toContain('"$ROOT/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"')
    expect(missingComponentsOf('node\ndsh\n')).toEqual(['node', 'dsh'])
    expect(missingComponentsOf('')).toEqual([])
    expect(missingComponentsOf('node\njunk\npnpm\n')).toEqual(['node', 'pnpm'])
  })

  it('builds the layout launch: pinned port, pid file, detached, log redirect', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers())
    const command = startCommandFor(profile, plan)
    expect(command).toContain('.dsh-desktop/runtime/bin/node')
    expect(command).toContain('.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(command).toContain('.dsh-remote.pid')
    expect(command).toContain('--host 127.0.0.1')
    expect(command).toContain(`--port "$4"`)
    expect(command).toContain('DSH_WEB_PORT=3080')
    expect(command).toContain('--no-open')
    expect(command).toContain('REMOTE_NOT_INSTALLED')
    expect(command).toContain('dsh-remote-web.log')
  })

  it('launches with the machine profile flag and falls back to remote', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers())
    const named = startCommandFor({ ...profile, profileName: 'work' }, plan)
    expect(named).toContain(`--profile "$5" --host`)
    expect(named).toContain('work')
    expect(named).toContain('档案: work')
    expect(startCommandFor(profile, plan)).toContain('档案: remote')
    expect(startCommandFor({ ...profile, profileName: 'a b;rm' }, plan)).toContain('档案: remote')
  })

  it('keeps the profile startCommand override untouched', () => {
    const overridden: MachineProfile = { ...profile, startCommand: 'my-launcher web --port 4000' }
    expect(startCommandFor(overridden))
      .toBe('mkdir -p "$HOME/.dsh" && ( my-launcher web --port 4000 >>"$HOME/.dsh/dsh-remote-web.log" 2>&1 < /dev/null & ) &')
  })
})

describe('health probes', () => {
  it('builds the root probe and the bundle probe with the wget fallback', () => {
    expect(rootProbeCommand(3080, 2500)).toBe(
      'if [ -n "$(command -v curl)" ]; then curl -s -m 3 http://127.0.0.1:3080/; '
      + 'elif [ -n "$(command -v wget)" ]; then wget -q -T 3 -O - http://127.0.0.1:3080/; case $? in 0|6|8) ;; *) exit 1 ;; esac; '
      + 'else echo "REMOTE_PROBE_NO_DOWNLOADER: 远端缺少 curl 与 wget，无法探测就绪状态" >&2; exit 1; fi',
    )
    expect(bundleProbeCommand('http://127.0.0.1:3080/plugins/x/client.js', 2500)).toBe(
      'if [ -n "$(command -v curl)" ]; then curl -s -m 3 -w \'\\n%{http_code}\' \'http://127.0.0.1:3080/plugins/x/client.js\'; '
      + 'elif [ -n "$(command -v wget)" ]; then wget -q -T 3 -O - \'http://127.0.0.1:3080/plugins/x/client.js\' && printf \'\\n200\\n\' || printf \'\\n0\\n\'; '
      + 'else echo "REMOTE_PROBE_NO_DOWNLOADER: 远端缺少 curl 与 wget，无法探测就绪状态" >&2; exit 1; fi',
    )
  })

  it('splits a bundle probe answer into body and status', () => {
    expect(splitBundleProbeStdout('console.log(1)\n200')).toEqual({ body: 'console.log(1)', status: 200 })
    expect(splitBundleProbeStdout('404\n')).toEqual({ body: '', status: 404 })
    expect(splitBundleProbeStdout('<!doctype html>\n200')).toEqual({ body: '<!doctype html>', status: 200 })
    expect(splitBundleProbeStdout('garbage')).toEqual({ body: 'garbage', status: 0 })
  })
})

describe('probe execution (real POSIX sh)', () => {
  /**
   * Run one generated probe under the real `sh` with a curated tool PATH:
   * the downloader selection must actually work, not just look right.
   */
  function runProbe(command: string, sandbox: string, tools: Record<string, string>): Promise<{ code: number, stdout: string, stderr: string }> {
    const binDir = join(sandbox, 'bin')
    mkdirSync(binDir, { recursive: true })
    for (const [name, body] of Object.entries(tools)) {
      writeFileSync(join(binDir, name), body)
      chmodSync(join(binDir, name), 0o755)
    }
    const scriptPath = join(sandbox, 'probe.sh')
    writeFileSync(scriptPath, command)
    // /bin/sh by absolute path: PATH holds only the sandbox bin dir, so
    // `command -v` sees exactly the fakes this case installs (the probe
    // itself needs nothing but shell builtins besides the downloader).
    const run = promisify(execFile)
    return run('/bin/sh', [scriptPath], { env: { ...process.env, HOME: sandbox, PATH: binDir } }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number, stdout?: string, stderr?: string }) =>
        ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
    )
  }

  // The fake curl serves a fixed body and honors `-w` (expanded to the
  // emulated status) like the real one, so the bundle probe parses cleanly.
  const CURL = [
    '#!/bin/sh',
    'printf \'curl-body\'',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "-w" ]; then printf \'\\n200\\n\'; fi',
    '  prev="$arg"',
    'done',
  ].join('\n')
  const WGET = '#!/bin/sh\nprintf \'wget-body\'\n'
  // Real GNU wget semantics (verified live on GNU Wget 1.21.2): a 401 auth
  // challenge exits 6, a 404/5xx server error exits 8, a connection-level
  // failure (refused/timeout) exits 4.
  const WGET_AUTH_CHALLENGE = '#!/bin/sh\nexit 6\n'
  const WGET_SERVER_ERROR = '#!/bin/sh\nexit 8\n'
  const WGET_REFUSED = '#!/bin/sh\nexit 4\n'

  it('root probe answers from curl and falls back to wget when curl is absent', async () => {
    const withCurl = await runProbe(rootProbeCommand(3080, 2500), tempDir(), { curl: CURL, wget: WGET })
    expect(withCurl).toMatchObject({ code: 0, stdout: 'curl-body' })
    const withWgetOnly = await runProbe(rootProbeCommand(3080, 2500), tempDir(), { wget: WGET })
    expect(withWgetOnly).toMatchObject({ code: 0, stdout: 'wget-body' })
  })

  it('root probe counts wget server answers (401→6, 404→8) as answered, a refused connection as not ready', async () => {
    // curl exits 0 on any HTTP response; wget answers with 6/8 there. The
    // probe must normalize, or an auth-fence instance never becomes ready
    // on wget-only remotes (verified live against a real 401 instance).
    for (const fake of [WGET_AUTH_CHALLENGE, WGET_SERVER_ERROR]) {
      const answered = await runProbe(rootProbeCommand(3080, 2500), tempDir(), { wget: fake })
      expect(answered.code).toBe(0)
      expect(answered.stdout).toBe('')
    }
    const refused = await runProbe(rootProbeCommand(3080, 2500), tempDir(), { wget: WGET_REFUSED })
    expect(refused.code).not.toBe(0)
  })

  it('root probe fails loud with the marker when neither downloader exists', async () => {
    const neither = await runProbe(rootProbeCommand(3080, 2500), tempDir(), {})
    expect(neither.code).not.toBe(0)
    expect(neither.stderr).toContain('REMOTE_PROBE_NO_DOWNLOADER')
  })

  it('bundle probe appends the real status under curl and synthesizes 200/0 under wget', async () => {
    const url = 'http://127.0.0.1:3080/plugins/x/client.js'
    const withCurl = await runProbe(bundleProbeCommand(url, 2500), tempDir(), { curl: CURL })
    expect(withCurl.code).toBe(0)
    expect(splitBundleProbeStdout(withCurl.stdout)).toEqual({ body: 'curl-body', status: 200 })
    const withWget = await runProbe(bundleProbeCommand(url, 2500), tempDir(), { wget: WGET })
    expect(withWget.code).toBe(0)
    expect(splitBundleProbeStdout(withWget.stdout)).toEqual({ body: 'wget-body', status: 200 })
    // Server answers (6/8) and connection failures (4) all report status 0
    // — never a healthy manifest.
    for (const fake of [WGET_AUTH_CHALLENGE, WGET_SERVER_ERROR, WGET_REFUSED]) {
      const failing = await runProbe(bundleProbeCommand(url, 2500), tempDir(), { wget: fake })
      expect(splitBundleProbeStdout(failing.stdout)).toEqual({ body: '', status: 0 })
    }
  })

  it('legacy verdict probe: wget 6/8 answer 4xx/5xx, exit 4 is no answer', async () => {
    for (const fake of [WGET_AUTH_CHALLENGE, WGET_SERVER_ERROR]) {
      const answered = await runProbe(legacyProbeCommand(3080, 2500), tempDir(), { wget: fake })
      expect(answered).toMatchObject({ code: 0, stdout: '4xx/5xx\n' })
    }
    const refused = await runProbe(legacyProbeCommand(3080, 2500), tempDir(), { wget: WGET_REFUSED })
    expect(refused.code).not.toBe(0)
    const healthy = await runProbe(legacyProbeCommand(3080, 2500), tempDir(), { wget: '#!/bin/sh\nexit 0\n' })
    expect(healthy).toMatchObject({ code: 0, stdout: '200\n' })
  })
})

describe('credentials', () => {
  it('reads the DEEPSEEK keys from a dsh .env document', () => {
    const dir = tempDir()
    const env = join(dir, '.env')
    writeFileSync(env, 'OTHER=1\nDEEPSEEK_API_KEY=sk-test-123\nDEEPSEEK_BASE_URL=https://api.example.com\n')
    expect(readEnvCredentials(env)).toEqual({
      apiKey: 'sk-test-123',
      baseUrl: 'https://api.example.com',
    })
  })

  it('strips surrounding quotes and treats blank keys as absent', () => {
    const dir = tempDir()
    const env = join(dir, '.env')
    writeFileSync(env, 'DEEPSEEK_API_KEY="sk-quoted"\nDEEPSEEK_BASE_URL=\n')
    expect(readEnvCredentials(env)).toEqual({ apiKey: 'sk-quoted' })
  })

  it('reports no credentials for a missing document', () => {
    expect(readEnvCredentials(join(tempDir(), 'nope.env'))).toEqual({})
  })

  it('writes credentials into the remote .env without clobbering an existing key', () => {
    const command = credentialsCopyCommand({ apiKey: 'sk-\'quoted\'', baseUrl: 'https://api.example.com' })
    expect(command).toContain(`printf 'DEEPSEEK_API_KEY=%s\\n' 'sk-'\\''quoted'\\'''`)
    expect(command).toContain('DEEPSEEK_BASE_URL')
    expect(command).toContain('grep -q \'^DEEPSEEK_API_KEY=\'')
    expect(command).toContain('echo copied')
    expect(command).toContain('echo existing')
    expect(command).toContain('umask 077')
    // The write merges: only the keys being written are filtered out of an
    // existing document, and it lands through the temp file + mv.
    expect(command).toContain(`grep -v -E '^DEEPSEEK_API_KEY=|^DEEPSEEK_BASE_URL='`)
    expect(command).toContain('"$HOME/.dsh/.env.new"')
    expect(command).toContain('mv -f "$HOME/.dsh/.env.new" "$HOME/.dsh/.env"')
  })
})

describe('credentials copy execution (real POSIX sh)', () => {
  /** Run one generated command under the real `sh` inside a sandboxed HOME. */
  function runCommand(command: string, sandbox: string): Promise<{ code: number, stdout: string, stderr: string }> {
    const scriptPath = join(sandbox, 'cmd.sh')
    writeFileSync(scriptPath, command)
    const run = promisify(execFile)
    return run('sh', [scriptPath], { env: { ...process.env, HOME: sandbox } }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number, stdout?: string, stderr?: string }) =>
        ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
    )
  }

  it('merges into an existing remote .env, keeping unrelated variables and replacing managed keys', async () => {
    const sandbox = tempDir()
    mkdirSync(join(sandbox, '.dsh'), { recursive: true })
    writeFileSync(join(sandbox, '.dsh', '.env'), 'OTHER_TOOL=1\nDEEPSEEK_BASE_URL=https://remote.example.com\n')
    const outcome = await runCommand(credentialsCopyCommand({ apiKey: 'sk-new', baseUrl: 'https://local.example.com' }), sandbox)
    expect(outcome.code).toBe(0)
    expect(outcome.stdout.trim()).toBe('copied')
    const env = readFileSync(join(sandbox, '.dsh', '.env'), 'utf8')
    expect(env).toContain('OTHER_TOOL=1')
    expect(env).toContain('DEEPSEEK_API_KEY=sk-new')
    expect(env).toContain('DEEPSEEK_BASE_URL=https://local.example.com')
    expect(env).not.toContain('remote.example.com')
    // umask 077 → the merged document stays owner-only; no temp file leaks.
    expect(statSync(join(sandbox, '.dsh', '.env')).mode & 0o777).toBe(0o600)
    expect(existsSync(join(sandbox, '.dsh', '.env.new'))).toBe(false)
  })

  it('keeps a remote-set DEEPSEEK_BASE_URL when the local env carries none', async () => {
    const sandbox = tempDir()
    mkdirSync(join(sandbox, '.dsh'), { recursive: true })
    writeFileSync(join(sandbox, '.dsh', '.env'), 'DEEPSEEK_BASE_URL=https://remote.example.com\nOTHER=2\n')
    const outcome = await runCommand(credentialsCopyCommand({ apiKey: 'sk-new' }), sandbox)
    expect(outcome.code).toBe(0)
    const env = readFileSync(join(sandbox, '.dsh', '.env'), 'utf8')
    expect(env).toContain('DEEPSEEK_API_KEY=sk-new')
    expect(env).toContain('DEEPSEEK_BASE_URL=https://remote.example.com')
    expect(env).toContain('OTHER=2')
  })

  it('creates the document from nothing when the remote has no .env yet', async () => {
    const sandbox = tempDir()
    const outcome = await runCommand(credentialsCopyCommand({ apiKey: 'sk-fresh' }), sandbox)
    expect(outcome.code).toBe(0)
    expect(outcome.stdout.trim()).toBe('copied')
    expect(readFileSync(join(sandbox, '.dsh', '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=sk-fresh\n')
  })

  it('reports existing and leaves the document untouched when the remote already has a key', async () => {
    const sandbox = tempDir()
    mkdirSync(join(sandbox, '.dsh'), { recursive: true })
    const before = 'DEEPSEEK_API_KEY=sk-remote\nOTHER=7\n'
    writeFileSync(join(sandbox, '.dsh', '.env'), before)
    const outcome = await runCommand(credentialsCopyCommand({ apiKey: 'sk-new' }), sandbox)
    expect(outcome.code).toBe(0)
    expect(outcome.stdout.trim()).toBe('existing')
    expect(readFileSync(join(sandbox, '.dsh', '.env'), 'utf8')).toBe(before)
  })
})

/** A boot page the bundle probe answers with real JavaScript. */
const BOOT_HTML = [
  '<html><head>',
  '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=1"></script>',
  '</head><body><script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/@deepseek-ai/dsh-client-ui-layout/client.js"}]};</script></body></html>',
].join('')

const BOOTSTRAP = {
  config: {},
  healthCheckTimeoutMs: 1000,
  healthPollIntervalMs: 5,
  healthPollAttempts: 3,
}

function plannerOf(plan: RemoteInstallPlan) {
  return async (): Promise<RemoteInstallPlan> => plan
}

describe('ensureRemoteInstance', () => {
  it('is satisfied immediately when the boot manifest answers with a real bundle', async () => {
    const session = new FakeSession((command) => {
      if (command.includes('-w'))
        return { code: 0, stdout: 'console.log(1)\n200', stderr: '' }
      return { code: 0, stdout: BOOT_HTML, stderr: '' }
    })
    const events: Array<{ stage: string, line: string, terminal?: string }> = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onEvent: (stage, line, options) => events.push({ stage, line, ...options?.terminal === undefined ? {} : { terminal: options.terminal } }),
    })).resolves.toBe('10.0.0.1:3080')
    expect(session.commands).toHaveLength(2)
    expect(events).toEqual([{ stage: 'ready', line: expect.stringContaining('已就绪'), terminal: 'success' }])
  })

  it('falls back to the legacy any-response verdict when the HTML carries no manifest', async () => {
    const session = new FakeSession((command) => {
      if (command.includes('/dev/null'))
        return { code: 0, stdout: '200', stderr: '' }
      return { code: 0, stdout: '<html>an old instance without a boot graph</html>', stderr: '' }
    })
    const events: string[] = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onEvent: (stage, line) => events.push(`${stage}: ${line}`),
    })).resolves.toBe('10.0.0.1:3080')
    expect(events[0]).toContain('旧探测兜底')
    expect(events[0]).toContain('root answered 200')
  })

  it('bootstraps a fresh machine end to end: probe → install → launch → ready', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    let started = false
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: 'node\ndsh\npnpm\n', stderr: '' }
      if (command.includes('trap cleanup EXIT'))
        return { code: 0, stdout: '::dsh install 远端初始化完成', stderr: '' }
      if (command.includes('dsh-remote.pid')) {
        started = true
        return { code: 0, stdout: '远端实例已拉起', stderr: '' }
      }
      // Readiness probes: refused until the launch, manifest-healthy after.
      if (command.includes('-w'))
        return { code: 0, stdout: 'console.log(1)\n200', stderr: '' }
      return started
        ? { code: 0, stdout: BOOT_HTML, stderr: '' }
        : { code: 7, stdout: '', stderr: 'refused' }
    })
    const events: Array<{ stage: string, line: string, terminal?: string, reason?: string }> = []
    const phases: unknown[] = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onProgress: progress => phases.push(progress),
      onEvent: (stage, line, options) => events.push({ stage, line, ...options ?? {} }),
    }, plannerOf(plan))).resolves.toBe('10.0.0.1:3080')
    const kinds = events.map(event => event.stage)
    expect(kinds).toEqual(['probe', 'probe', 'probe', 'launch', 'ready'])
    expect(events[0]?.line).toContain('探测远端平台')
    expect(events[1]?.line).toContain('linux/x64')
    expect(events[2]?.line).toContain('缺失组件: node, dsh, pnpm')
    expect(events[4]?.terminal).toBe('success')
    expect(phases).toEqual([{ phase: 'starting' }, { phase: 'probing', attempt: 1, total: 3 }])
    expect(session.commands.some(command => command.includes('https://nodejs.org/dist/'))).toBe(true)
  })

  it('skips the install when the three components are already present', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    let started = false
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: '', stderr: '' }
      if (command.includes('dsh-remote.pid')) {
        started = true
        return { code: 0, stdout: '远端实例已拉起', stderr: '' }
      }
      if (command.includes('-w'))
        return { code: 0, stdout: 'console.log(1)\n200', stderr: '' }
      return started
        ? { code: 0, stdout: BOOT_HTML, stderr: '' }
        : { code: 7, stdout: '', stderr: '' }
    })
    const events: string[] = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onEvent: (stage, line) => events.push(`${stage}: ${line}`),
    }, plannerOf(plan))).resolves.toBe('10.0.0.1:3080')
    expect(events.some(entry => entry.includes('三件套已就绪，跳过安装'))).toBe(true)
    expect(session.commands.some(command => command.includes('trap cleanup EXIT'))).toBe(false)
  })

  it('records the terminal failure and reason when the install script fails', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: 'node\n', stderr: '' }
      if (command.includes('trap cleanup EXIT'))
        return { code: 11, stdout: '::dsh failed checksum mismatch: node.tar.gz', stderr: '' }
      return { code: 7, stdout: '', stderr: '' }
    })
    const failures: Array<{ line: string, terminal?: string, reason?: string }> = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onEvent: (stage, line, options) => {
        if (stage === 'failed')
          failures.push({ line, ...options ?? {} })
      },
    }, plannerOf(plan))).rejects.toThrow(/install failed on remote/)
    expect(failures[0]?.terminal).toBe('failed')
    expect(failures[0]?.reason).toContain('checksum mismatch')
  })

  it('reports unsupported platforms as a terminal failure', async () => {
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'MINGW64_NT-10.0-19045 x86_64\n', stderr: '' }
      return { code: 7, stdout: '', stderr: '' }
    })
    const failures: string[] = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onEvent: (stage, line) => {
        if (stage === 'failed')
          failures.push(line)
      },
    })).rejects.toThrow(/REMOTE_PLATFORM_UNSUPPORTED/)
    expect(failures).toHaveLength(1)
  })

  it('fails loud with fallback details when the instance never becomes ready', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: '', stderr: '' }
      if (command.includes('tail'))
        return { code: 0, stdout: 'err1\nerr2\nerr3\nerr4\nerr5\nerr6', stderr: '' }
      if (command.includes('dsh-remote.pid'))
        return { code: 0, stdout: '远端实例已拉起', stderr: '' }
      return { code: 7, stdout: '', stderr: '' }
    })
    const failures: Array<{ reason?: string, terminal?: string }> = []
    await expect(ensureRemoteInstance(session, profile, {
      ...BOOTSTRAP,
      healthPollAttempts: 2,
    }, {
      onEvent: (_stage, _line, options) => {
        if (options?.terminal === 'failed')
          failures.push({ terminal: options.terminal, ...options.reason === undefined ? {} : { reason: options.reason } })
      },
    }, plannerOf(plan))).rejects.toThrow(/did not become ready.*fallback probe: root no answer.*err2 \| err3 \| err4 \| err5 \| err6/)
    expect(failures[0]?.terminal).toBe('failed')
  })

  it('says the remote has no downloader instead of a misleading not-ready', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: '', stderr: '' }
      if (command.includes('dsh-remote.pid'))
        return { code: 0, stdout: '远端实例已拉起', stderr: '' }
      if (command.includes('tail'))
        return { code: 0, stdout: 'instance log line\n', stderr: '' }
      if (command.includes('/dev/null'))
        // The legacy verdict probe: this remote has neither curl nor wget,
        // so its else-arm prints the marker on stdout.
        return { code: 0, stdout: REMOTE_PROBE_NO_DOWNLOADER, stderr: '' }
      // The root/bundle probes fail (their else-arm exits 1) — not ready.
      return { code: 1, stdout: '', stderr: '' }
    })
    const failures: string[] = []
    await expect(ensureRemoteInstance(session, profile, {
      ...BOOTSTRAP,
      healthPollAttempts: 1,
    }, {
      onEvent: (_stage, _line, options) => {
        if (options?.terminal === 'failed')
          failures.push(options.reason ?? '')
      },
    }, plannerOf(plan))).rejects.toThrow(/no downloader/)
    expect(failures[0]).toContain('REMOTE_PROBE_NO_DOWNLOADER')
  })

  it('surfaces REMOTE_NOT_INSTALLED when the launch finds an incomplete runtime', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: '', stderr: '' }
      if (command.includes('dsh-remote.pid'))
        return { code: 1, stdout: 'REMOTE_NOT_INSTALLED: 远端三件套未安装完整', stderr: '' }
      return { code: 7, stdout: '', stderr: '' }
    })
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {}, plannerOf(plan)))
      .rejects
      .toThrow(/REMOTE_NOT_INSTALLED/)
  })

  it('summarizes a failed command for operators', () => {
    expect(describeExecFailure(1, 'sh: dsh: not found\n')).toBe('exit 1: sh: dsh: not found')
    expect(describeExecFailure(null, '  ')).toBe('exit ?')
  })

  it('takes the first non-empty line of a probe result', () => {
    expect(firstLineOf('ok\nother\n')).toBe('ok')
    expect(firstLineOf('\n  \nok')).toBe('ok')
    expect(firstLineOf('')).toBe('')
  })
})
