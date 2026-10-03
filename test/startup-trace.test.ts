import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface TraceReport {
  reason: string
  elapsedMs: number
  preloadAtMs: number
  cpuMs: { user: number, system: number, total: number }
  nonCpuWallMs: number
  maxTimerGapMs: number
  eventLoop: { activeMs: number, idleMs: number }
  profile: {
    nodes: Array<{ id: number, callFrame: { functionName: string, url: string } }>
    samples: number[]
    timeDeltas: number[]
  }
}

const preload = fileURLToPath(new URL('../src-tauri/src/service/workflow/startup_trace.cjs', import.meta.url))
const roots: string[] = []
const privateToken = 'STARTUP_PRIVATE_TOKEN_924671'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-trace-'))
  roots.push(root)
  mkdirSync(join(root, 'node_modules', 'startup-fixture'), { recursive: true })
  return root
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((ok, fail) => server.listen(0, '127.0.0.1', ok).once('error', fail))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP fixture address')
  await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()))
  return address.port
}

async function runFixture(root: string, source: string, enabled = '1', outputDir = join(root, 'reports')) {
  const entry = join(root, 'node_modules', 'startup-fixture', 'index.cjs')
  writeFileSync(entry, source)
  const port = await freePort()
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:DSH_|BILI_|BILLION_CONTEXT|NODE_OPTIONS)/i.test(name)))
  const output = join(root, 'child.log')
  const fd = openSync(output, 'w')
  let child: ChildProcess
  try {
    child = spawn(process.execPath, ['--require', preload, entry, privateToken], {
      cwd: root,
      env: {
        ...environment,
        HOME: root,
        USERPROFILE: root,
        APPDATA: join(root, 'appdata'),
        LOCALAPPDATA: join(root, 'localappdata'),
        DSH_HOME: join(root, 'home'),
        DSH_E2E_HOME: join(root, 'home'),
        DSH_WEB_PORT: String(port),
        DSH_STARTUP_TRACE: enabled,
        DSH_STARTUP_TRACE_DIR: outputDir,
        PRIVATE_SESSION_CONTENT: privateToken,
      },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
  }
  finally {
    closeSync(fd)
  }
  const code = await new Promise<number | null>((ok, fail) => {
    const timeout = setTimeout(() => {
      child.kill()
      fail(new Error(`Startup fixture exceeded 8 seconds: ${readFileSync(output, 'utf8')}`))
    }, 8_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      fail(error)
    })
    child.once('exit', (exitCode) => {
      clearTimeout(timeout)
      ok(exitCode)
    })
  })
  return { code, output: readFileSync(output, 'utf8') }
}

function readReport(root: string): { report: TraceReport, raw: string } {
  const reports = readdirSync(join(root, 'reports'))
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatch(/^startup-\d+-\d+\.json$/)
  const raw = readFileSync(join(root, 'reports', reports[0]), 'utf8')
  return { raw, report: JSON.parse(raw) as TraceReport }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^dsh-startup-trace-/)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('opt-in Node startup trace', () => {
  it('leaves the process untouched when the trace flag is not exactly 1', async () => {
    const root = fixture()
    const result = await runFixture(root, `process.stdout.write('fixture-ready')`, 'true')
    expect(result).toEqual({ code: 0, output: 'fixture-ready' })
    expect(existsSync(join(root, 'reports'))).toBe(false)
  })

  it('samples real CPU and blocking wait until the main HTTP port listens', async () => {
    const root = fixture()
    const result = await runFixture(root, `
      const http = require('node:http')
      const { performance } = require('node:perf_hooks')
      const loopStarted = performance.eventLoopUtilization()
      const auxiliary = http.createServer()
      auxiliary.listen(0, '127.0.0.1', () => {
        function spin_${privateToken}() {
          const until = Date.now() + 220
          while (Date.now() < until) Math.sqrt(Math.random())
        }
        spin_${privateToken}()
        new (require('node:vm').Script)('const until = Date.now() + 100; while (Date.now() < until) Math.random();', { filename: 'node:${privateToken}' }).runInThisContext()
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
        setTimeout(() => {
          const idleMs = performance.eventLoopUtilization(loopStarted).idle
          process.stdout.write('fixture-idle-ms=' + idleMs + '\\n')
          const main = http.createServer((_request, response) => response.end(process.env.PRIVATE_SESSION_CONTENT))
          main.listen(Number(process.env.DSH_WEB_PORT), '127.0.0.1', () => {
            http.get('http://127.0.0.1:' + process.env.DSH_WEB_PORT + '/?token=' + process.argv[2], response => {
              response.resume()
              response.on('end', () => {
                process.stdout.write('fixture-ready')
                main.close()
                auxiliary.close()
              })
            })
          })
        }, 120)
      })
    `)
    expect(result.code).toBe(0)
    expect(result.output).toContain('fixture-ready')
    expect(result.output).toContain('STARTUP_TRACE: reason=listen')
    const { report, raw } = readReport(root)
    expect(report.reason).toBe('listen')
    expect(report.elapsedMs).toBeGreaterThanOrEqual(570)
    expect(report.cpuMs.total).toBeGreaterThan(50)
    expect(report.nonCpuWallMs).toBeGreaterThan(100)
    expect(report.maxTimerGapMs).toBeGreaterThanOrEqual(450)
    expect(report.preloadAtMs).toBeGreaterThanOrEqual(0)
    const idleLine = result.output.split('\n').find(line => line.startsWith('fixture-idle-ms='))
    expect(idleLine).toMatch(/^fixture-idle-ms=\d+(?:\.\d+)?$/)
    expect(report.eventLoop.idleMs).toBeCloseTo(Number(idleLine?.slice('fixture-idle-ms='.length)), 3)
    expect(report.profile.samples.length).toBeGreaterThan(10)
    expect(report.profile.timeDeltas.length).toBe(report.profile.samples.length)
    expect(report.profile.nodes.some(node => node.callFrame.url === 'node_modules/startup-fixture/index.cjs')).toBe(true)
    expect(raw).not.toContain(privateToken)
    expect(raw).not.toContain(root.replaceAll('\\', '/'))
    expect(raw).not.toContain(encodeURI(root.replaceAll('\\', '/')))
    expect(raw).not.toContain('PRIVATE_SESSION_CONTENT')
    expect(raw).not.toContain('?token=')
  })

  it('writes a startup report without changing an early process exit code', async () => {
    const root = fixture()
    const result = await runFixture(root, `process.exit(2)`)
    expect(result.code).toBe(2)
    const { report } = readReport(root)
    expect(report.reason).toBe('exit')
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.output).toContain('STARTUP_TRACE: reason=exit')
  })

  it('does not profile forked subprocesses that inherit the preload argument', async () => {
    const root = fixture()
    const descendant = join(root, 'descendant.cjs')
    writeFileSync(descendant, `process.stdout.write('descendant-ready')`)
    const result = await runFixture(root, `
      const { fork } = require('node:child_process')
      const http = require('node:http')
      const child = fork(${JSON.stringify(descendant)}, [], { stdio: 'inherit' })
      child.once('exit', code => {
        if (code !== 0) process.exit(code || 1)
        const server = http.createServer()
        server.listen(Number(process.env.DSH_WEB_PORT), '127.0.0.1', () => server.close())
      })
    `)
    expect(result.code).toBe(0)
    expect(result.output).toContain('descendant-ready')
    const { report } = readReport(root)
    expect(report.reason).toBe('listen')
    expect(result.output.match(/STARTUP_TRACE: /g)).toHaveLength(1)
  })

  it('keeps startup successful when the report destination is not writable', async () => {
    const root = fixture()
    const destination = join(root, 'not-a-directory')
    writeFileSync(destination, privateToken)
    const result = await runFixture(root, `process.stdout.write('fixture-ready')`, '1', destination)
    expect(result.code).toBe(0)
    expect(result.output).toContain('fixture-ready')
    expect(result.output).toContain('STARTUP_TRACE_FAILED:')
    expect(result.output).not.toContain(privateToken)
    expect(result.output).not.toContain(root)
    expect(readFileSync(destination, 'utf8')).toBe(privateToken)
  })
})
