import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type ShellKind = 'cmd' | 'ps1' | 'sh'
type Forwarding = 'selected' | 'path'

interface Fixture {
  shell: ShellKind
  shim: string
  user: string
  node: string
  bundle: string
  home: string
  env: NodeJS.ProcessEnv
}

interface ShellResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const system32 = join(systemRoot, 'System32')
const powershellRoot = join(system32, 'WindowsPowerShell', 'v1.0')
const programs: Record<ShellKind, string> = {
  cmd: join(system32, 'cmd.exe'),
  ps1: join(powershellRoot, 'powershell.exe'),
  sh: process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\sh.exe' : '/bin/sh',
}
const shells: ShellKind[] = process.platform === 'win32' ? ['cmd', 'ps1', 'sh'] : ['sh']
const generatorSource = readFileSync(new URL('../src-tauri/src/service/cli/shim/build.rs', import.meta.url), 'utf8')
const fragmentSource = readFileSync(new URL('../src-tauri/src/service/cli/shim/templates.rs', import.meta.url), 'utf8')
const tempBase = realpathSync(tmpdir())
const owned = new Map<number, ChildProcess>()
let root: string
let runIndex = 0

function shellPath(shell: ShellKind, path: string): string {
  if (shell !== 'sh' || process.platform !== 'win32')
    return path
  return path.replace(/\\/g, '/').replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`)
}

function quoteLiteral(shell: ShellKind, path: string): string {
  if (shell === 'cmd')
    return path.replace(/%/g, '%%')
  if (shell === 'ps1')
    return path.replace(/'/g, '\'\'')
  return shellPath(shell, path).replace(/'/g, '\'\\\'\'')
}

function renderShim(shell: ShellKind, fixture: Pick<Fixture, 'node' | 'bundle'>): string {
  const raw = new RegExp(`^pub fn build_pnpm_${shell}_shim\\([^\\n]*\\)[^\\n]*\\{[\\s\\S]*?r#"([\\s\\S]*?)"#,`, 'm').exec(generatorSource)?.[1]
  const nodeResolve = new RegExp(`const ${shell.toUpperCase()}_NODE_RESOLVE: &str = r#"([\\s\\S]*?)"#;`).exec(fragmentSource)?.[1]
  if (raw === undefined || nodeResolve === undefined)
    throw new Error(`The real ${shell} pnpm template or NODE_RESOLVE constant was not found`)
  const values: Record<string, string> = {
    node_bin: quoteLiteral(shell, fixture.node),
    node_dir: quoteLiteral(shell, dirname(fixture.node)),
    git_dir: quoteLiteral(shell, join(root, 'absent bundled git')),
    pnpm_bin: quoteLiteral(shell, fixture.bundle),
    node_resolve: nodeResolve,
  }
  const content = raw.replace(/\{\{|\}\}|\{([a-z_]+)\}/g, (token, key: string | undefined) => {
    if (token === '{{')
      return '{'
    if (token === '}}')
      return '}'
    if (key === undefined || !(key in values))
      throw new Error(`Unexpected Rust format placeholder: ${token}`)
    return values[key]!
  })
  return shell === 'cmd' ? content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : content
}

function writeScript(shell: ShellKind, path: string, content: string): void {
  writeFileSync(path, shell === 'cmd' ? content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : content)
  if (shell === 'sh')
    chmodSync(path, 0o700)
}

function prepare(shell: ShellKind, forwarding: Forwarding, bundled: boolean): Fixture {
  const home = join(root, 'home')
  const shimDir = join(root, 'desktop bin')
  const userDir = join(root, 'user bin')
  const nodeDir = join(root, 'node fixture')
  const bundle = join(root, 'app', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
  for (const path of [home, shimDir, userDir, nodeDir, dirname(bundle), join(home, 'AppData', 'Local'), join(home, 'AppData', 'Roaming')])
    mkdirSync(path, { recursive: true })
  const extension = shell === 'cmd' ? '.cmd' : shell === 'ps1' ? '.ps1' : ''
  const shim = join(shimDir, `pnpm${extension}`)
  const user = join(userDir, `pnpm${extension}`)
  const node = join(nodeDir, shell === 'sh' ? 'node' : 'node.cmd')
  writeScript(shell === 'sh' ? 'sh' : 'cmd', node, shell === 'sh'
    ? '#!/bin/sh\nprintf "%s\\n" BUNDLED\nexit 0\n'
    : '@echo off\necho BUNDLED\nexit /b 0\n')
  if (bundled)
    writeFileSync(bundle, 'isolated bundled pnpm fixture\n')
  const path = shell === 'sh'
    ? `${shellPath(shell, shimDir)}:${shellPath(shell, userDir)}:/usr/bin:/bin`
    : `${shimDir};${userDir};${system32};${powershellRoot}`
  const env: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    COMSPEC: programs.cmd,
    OS: 'Windows_NT',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: path,
    PSModulePath: join(powershellRoot, 'Modules'),
    HOME: shellPath(shell, home),
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TMP: root,
    TEMP: root,
    TMPDIR: root,
    LANG: 'C',
    LC_ALL: 'C',
    DSH_E2E_HOME: home,
    DSH_NODE: shellPath(shell, node),
  }
  if (forwarding === 'selected')
    env.DSH_PNPM = shellPath(shell, user)
  const fixture = { shell, shim, user, node, bundle, home, env }
  writeScript(shell, shim, renderShim(shell, fixture))
  return fixture
}

function writeCycle(fixture: Fixture): void {
  const { shell, user } = fixture
  if (shell === 'cmd') {
    writeScript(shell, user, '@echo off\nset /a FIXTURE_HOPS+=1 >nul\necho HOP\nif %FIXTURE_HOPS% GEQ 24 (\n  echo FIXTURE_CYCLE_OVERFLOW 1>&2\n  exit /b 97\n)\npnpm %*\nexit /b %ERRORLEVEL%\n')
  }
  else if (shell === 'ps1') {
    writeScript(shell, user, '$env:FIXTURE_HOPS = ([int]$env:FIXTURE_HOPS + 1).ToString()\n[Console]::Out.WriteLine("HOP")\nif ([int]$env:FIXTURE_HOPS -ge 24) {\n  [Console]::Error.WriteLine("FIXTURE_CYCLE_OVERFLOW")\n  exit 97\n}\n& pnpm @args\nexit $LASTEXITCODE\n')
  }
  else {
    writeScript(shell, user, '#!/bin/sh\nFIXTURE_HOPS=$(( FIXTURE_HOPS + 1 ))\nexport FIXTURE_HOPS\nprintf "%s\\n" HOP\nif [ "$FIXTURE_HOPS" -ge 24 ]; then\n  printf "%s\\n" FIXTURE_CYCLE_OVERFLOW >&2\n  exit 97\nfi\nexec pnpm "$@"\n')
  }
}

function killOwned(child: ChildProcess): void {
  if (child.pid === undefined || !owned.has(child.pid))
    return
  if (child.pid === process.pid)
    throw new Error('Refusing to terminate the test runner')
  if (process.platform === 'win32') {
    const result = spawnSync(join(system32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000,
    })
    if (result.error !== undefined)
      throw result.error
    if (result.status !== 0)
      throw new Error(`Owned fixture process tree ${child.pid} could not be terminated: ${result.status}`)
  }
  else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        throw error
    }
  }
}

async function runShell(fixture: Fixture, script = fixture.shim, arg = 'cycle'): Promise<ShellResult> {
  const { shell, home, env } = fixture
  const stdoutFile = join(root, `stdout-${runIndex}.log`)
  const stderrFile = join(root, `stderr-${runIndex++}.log`)
  const stdoutFd = openSync(stdoutFile, 'w')
  const stderrFd = openSync(stderrFile, 'w')
  const args = shell === 'cmd'
    ? ['/d', '/s', '/c', `""${script}" "${arg}""`]
    : shell === 'ps1'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, arg]
      : [shellPath(shell, script), arg]
  let child: ChildProcess
  try {
    child = spawn(programs[shell], args, {
      cwd: home,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: shell === 'cmd',
      detached: process.platform !== 'win32',
      stdio: ['ignore', stdoutFd, stderrFd],
    })
  }
  finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }
  if (child.pid !== undefined)
    owned.set(child.pid, child)
  return await new Promise<ShellResult>((resolve, reject) => {
    let settled = false
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    let failure: unknown
    const timer = setTimeout(() => {
      if (settled)
        return
      failure = new Error(`${shell} isolated fixture exceeded its 12-second deadline`)
      try {
        if (child.exitCode === null && child.signalCode === null)
          killOwned(child)
      }
      catch (error) {
        failure = error
      }
      stopTimer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(failure)
        }
      }, 5_000)
    }, 12_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      clearTimeout(stopTimer)
      if (child.pid !== undefined)
        owned.delete(child.pid)
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(stopTimer)
      if (child.pid !== undefined)
        owned.delete(child.pid)
      if (settled)
        return
      settled = true
      if (failure !== undefined) {
        reject(failure)
        return
      }
      resolve({
        code,
        signal,
        stdout: readFileSync(stdoutFile, 'utf8').replace(/\r\n/g, '\n'),
        stderr: readFileSync(stderrFile, 'utf8').replace(/\r\n/g, '\n'),
      })
    })
  })
}

beforeAll(() => {
  for (const shell of shells)
    accessSync(programs[shell], constants.X_OK)
  if (process.platform === 'win32')
    accessSync(join(system32, 'taskkill.exe'), constants.X_OK)
})

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tempBase, 'pnpm-shim-chain-')))
})

afterEach(async () => {
  try {
    for (const child of [...owned.values()]) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('An owned fixture process did not close after termination')), 5_000)
        child.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        try {
          if (child.exitCode === null && child.signalCode === null)
            killOwned(child)
        }
        catch (error) {
          clearTimeout(timer)
          reject(error)
        }
      })
    }
    expect(owned.size).toBe(0)
    expect(dirname(root)).toBe(tempBase)
    expect(basename(root)).toMatch(/^pnpm-shim-chain-[a-z0-9]+$/i)
    rmSync(root, { recursive: true, force: true })
  }
  finally {
    vi.restoreAllMocks()
  }
})

describe.each(shells)('%s real pnpm forwarding-chain template', (shell) => {
  it.each<Forwarding>(['selected', 'path'])('bounds a no-bundle %s cycle at 16 forwards before the fixture safety stop', async (forwarding) => {
    const fixture = prepare(shell, forwarding, false)
    writeCycle(fixture)
    const result = await runShell(fixture)
    expect(result).toEqual({
      code: 1,
      signal: null,
      stdout: 'HOP\n'.repeat(16),
      stderr: '[pnpm] PNPM_REENTRY_LIMIT: Recursive forwarding exceeded 16 calls.\n',
    })
  }, 25_000)

  it.each<Forwarding>(['selected', 'path'])('escapes a %s cycle through the existing bundle instead of exhausting the chain', async (forwarding) => {
    const fixture = prepare(shell, forwarding, true)
    writeCycle(fixture)
    const result = await runShell(fixture)
    expect(result).toEqual({ code: 0, signal: null, stdout: 'HOP\nBUNDLED\n', stderr: '' })
  }, 25_000)

  it.each<Forwarding>(['selected', 'path'])('allows one %s forward from a 15-character lexical prefix and refuses a 16-character prefix', async (forwarding) => {
    const fixture = prepare(shell, forwarding, false)
    if (shell === 'cmd') {
      writeScript(shell, fixture.user, '@echo off\necho FORWARDED\necho CHAIN=%DSH_PNPM_SHIM_CHAIN%\nexit /b 37\n')
    }
    else if (shell === 'ps1') {
      writeScript(shell, fixture.user, '[Console]::Out.WriteLine(\'FORWARDED\')\n[Console]::Out.WriteLine(\'CHAIN=\' + $env:DSH_PNPM_SHIM_CHAIN)\nexit 37\n')
    }
    else {
      writeScript(shell, fixture.user, '#!/bin/sh\nprintf "%s\\n" FORWARDED\nprintf "CHAIN=%s\\n" "$DSH_PNPM_SHIM_CHAIN"\nexit 37\n')
    }
    fixture.env.DSH_PNPM_SHIM_CHAIN = 'prefix123456789'
    expect(await runShell(fixture)).toEqual({ code: 37, signal: null, stdout: 'FORWARDED\nCHAIN=prefix1234567891\n', stderr: '' })
    fixture.env.DSH_PNPM_SHIM_CHAIN = 'prefix1234567890'
    expect(await runShell(fixture)).toEqual({ code: 1, signal: null, stdout: '', stderr: '[pnpm] PNPM_REENTRY_LIMIT: Recursive forwarding exceeded 16 calls.\n' })
  }, 25_000)

  it('permits an inherited guard to call the same shim and same user pnpm for a genuine nested invocation', async () => {
    const fixture = prepare(shell, 'selected', false)
    fixture.env.DSH_PNPM_SHIM_GUARD = '1'
    if (shell === 'cmd') {
      writeScript(shell, fixture.user, `@echo off\nif "%~1"=="inner" (\n  echo INNER\n  exit /b 37\n)\necho OUTER\n"${fixture.shim}" inner\nexit /b %ERRORLEVEL%\n`)
    }
    else if (shell === 'ps1') {
      writeScript(shell, fixture.user, `if ($args[0] -eq 'inner') {\n  [Console]::Out.WriteLine('INNER')\n  exit 37\n}\n[Console]::Out.WriteLine('OUTER')\n& '${quoteLiteral(shell, fixture.shim)}' inner\nexit $LASTEXITCODE\n`)
    }
    else {
      writeScript(shell, fixture.user, `#!/bin/sh\nif [ "$1" = inner ]; then\n  printf "%s\\n" INNER\n  exit 37\nfi\nprintf "%s\\n" OUTER\nexec '${quoteLiteral(shell, fixture.shim)}' inner\n`)
    }
    const result = await runShell(fixture, fixture.shim, 'outer')
    expect(result).toEqual({ code: 37, signal: null, stdout: 'OUTER\nINNER\n', stderr: '' })
  }, 25_000)
})

if (process.platform === 'win32') {
  describe('powerShell same-process pnpm environment restoration', () => {
    it.each([
      { name: 'unset', guard: undefined, chain: undefined, output: 'FORWARDED\nGUARD=[]\nCHAIN=[]\n' },
      { name: 'custom prefix', guard: 'caller-guard', chain: 'customprefix', output: 'FORWARDED\nGUARD=[caller-guard]\nCHAIN=[customprefix]\n' },
    ])('restores the $name guard and chain after a selected pnpm returns', async ({ guard, chain, output }) => {
      const fixture = prepare('ps1', 'selected', false)
      const target = join(root, 'returning user.cmd')
      writeScript('cmd', target, '@echo off\necho FORWARDED\nexit /b 37\n')
      fixture.env.DSH_PNPM = target
      if (guard !== undefined)
        fixture.env.DSH_PNPM_SHIM_GUARD = guard
      if (chain !== undefined)
        fixture.env.DSH_PNPM_SHIM_CHAIN = chain
      const driver = join(root, 'same-process driver.ps1')
      writeScript('ps1', driver, `& '${quoteLiteral('ps1', fixture.shim)}' probe\n$code = $LASTEXITCODE\n[Console]::Out.WriteLine('GUARD=[' + $env:DSH_PNPM_SHIM_GUARD + ']')\n[Console]::Out.WriteLine('CHAIN=[' + $env:DSH_PNPM_SHIM_CHAIN + ']')\nexit $code\n`)
      const result = await runShell(fixture, driver, 'restore')
      expect(result).toEqual({ code: 37, signal: null, stdout: output, stderr: '' })
    }, 25_000)
  })
}
