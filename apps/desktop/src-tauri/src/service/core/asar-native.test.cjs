'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')
const childProcess = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const { createRequire, Module } = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const { pathToFileURL } = require('node:url')
const { promisify } = require('node:util')
const { Worker } = require('node:worker_threads')
const register = require('./asar-native.cjs')

const scratch = path.resolve('.temp/native-probe')
fs.mkdirSync(scratch, { recursive: true })

function fixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, 'unit-'))
  const archive = path.join(root, 'core')
  const cache = path.join(root, 'cache')
  fs.mkdirSync(archive)
  const hook = register(archive, cache)
  function write(filename, content) {
    const destination = path.join(archive, filename)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, content)
    return destination
  }
  const f = { archive, cache, hook, write, load: createRequire(path.join(archive, 'entry.cjs')) }
  t.after(() => {
    f.hook.deregister()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return f
}

test('native wrapper and complete scoped package resources use the same cache path', (t) => {
  const f = fixture(t)
  f.write('node_modules/@scope/native/package.json', JSON.stringify({ main: 'lib/index.cjs' }))
  f.write('node_modules/@scope/native/lib/index.cjs', 'module.exports = __dirname')
  const helper = f.write('node_modules/@scope/native/bin/helper', 'native helper')
  fs.chmodSync(helper, 0o755)
  f.write('node_modules/@scope/native/lib/native.node', 'not loaded')
  assert.equal(f.load('@scope/native'), path.join(f.cache, 'node_modules/@scope/native/lib'))
  assert.equal(fs.readFileSync(path.join(f.cache, 'node_modules/@scope/native/bin/helper'), 'utf8'), 'native helper')
  assert.equal(fs.statSync(path.join(f.cache, 'node_modules/@scope/native/bin/helper')).mode, fs.statSync(helper).mode)
  assert.equal(fs.readFileSync(path.join(f.cache, 'node_modules/@scope/native/.dsh-native-complete'), 'utf8'), '1')
})

test('cache wrapper resolves nested JavaScript dependencies from its original archive parent', (t) => {
  const f = fixture(t)
  f.write('node_modules/dep/index.js', 'module.exports = "root"')
  f.write('node_modules/native/index.js', 'module.exports = require("dep")')
  f.write('node_modules/native/binding.node', 'not loaded')
  f.write('node_modules/native/node_modules/dep/index.js', 'module.exports = "nested"')
  f.write('node_modules/dep/binding.node', 'not loaded')
  assert.equal(f.load('dep'), 'root')
  assert.equal(f.load('native'), 'nested')
  assert.equal(fs.existsSync(path.join(f.cache, 'node_modules/native/node_modules/dep/index.js')), false)
})

test('missing cache dependency falls back to archive without mixing a hoisted version', (t) => {
  const f = fixture(t)
  f.write('node_modules/dep/index.js', 'module.exports = "root"')
  f.write('node_modules/dep/binding.node', 'not loaded')
  f.write('node_modules/outer/index.js', 'module.exports = require("native")')
  f.write('node_modules/outer/node_modules/dep/index.js', 'module.exports = "outer"')
  f.write('node_modules/outer/node_modules/native/index.js', 'module.exports = require("dep")')
  f.write('node_modules/outer/node_modules/native/binding.node', 'not loaded')
  assert.equal(f.load('dep'), 'root')
  assert.equal(f.load('outer'), 'outer')
  assert.equal(fs.existsSync(path.join(f.cache, 'node_modules/outer/index.js')), false)
  assert.equal(fs.existsSync(path.join(f.cache, 'node_modules/outer/node_modules/dep/index.js')), false)
})

test('deregister restores the CommonJS resolver and remains idempotent', (t) => {
  const resolveFilename = Module._resolveFilename
  const f = fixture(t)
  assert.notEqual(Module._resolveFilename, resolveFilename)
  assert.equal(f.load('node:fs'), fs)
  f.hook.deregister()
  assert.equal(Module._resolveFilename, resolveFilename)
  f.hook.deregister()
  assert.equal(Module._resolveFilename, resolveFilename)
})

for (const nested of [false, true]) {
  test('HMR pre-resolution keeps ' + (nested ? 'nested' : 'hoisted') + ' dependencies on their archive parent', (t) => {
    const f = fixture(t)
    f.write('node_modules/dep/index.js', 'module.exports = "root"')
    f.write('node_modules/dep/binding.node', 'not loaded')
    f.write('node_modules/outer/index.js', 'module.exports = require("native")')
    f.write('node_modules/outer/node_modules/native/index.js', 'module.exports = require("dep")')
    f.write('node_modules/outer/node_modules/native/binding.node', 'not loaded')
    if (nested)
      f.write('node_modules/outer/node_modules/dep/index.js', 'module.exports = "nested"')
    const load = Module._load
    Module._load = function (request, parent, isMain, ...options) {
      const filename = Module.isBuiltin(request) ? request : Module._resolveFilename(request, parent, isMain)
      return load.call(this, filename, parent, isMain, ...options)
    }
    try {
      if (nested)
        assert.equal(f.load('dep'), 'root')
      assert.equal(f.load('outer'), nested ? 'nested' : 'root')
      assert.equal(fs.existsSync(path.join(f.cache, 'node_modules/outer/index.js')), false)
      assert.equal(fs.existsSync(path.join(f.cache, 'node_modules/outer/node_modules/dep/index.js')), false)
    }
    finally {
      Module._load = load
    }
  })
}

test('node-pty wrapper is materialized before it calculates helper directories', (t) => {
  const f = fixture(t)
  f.write('node_modules/node-pty/index.js', 'module.exports = __dirname')
  f.write('node_modules/node-pty/helpers/agent.js', 'helper')
  assert.equal(f.load('node-pty'), path.join(f.cache, 'node_modules/node-pty'))
  assert.equal(fs.readFileSync(path.join(f.cache, 'node_modules/node-pty/helpers/agent.js'), 'utf8'), 'helper')
})

test('pure JavaScript parent remains archived when only a nested dependency is native', (t) => {
  const f = fixture(t)
  f.write('node_modules/outer/index.js', 'module.exports = __dirname')
  f.write('node_modules/outer/node_modules/native/index.js', 'module.exports = __dirname')
  f.write('node_modules/outer/node_modules/native/binding.node', 'not loaded')
  assert.equal(f.load('outer'), path.join(f.archive, 'node_modules/outer'))
  assert.equal(fs.existsSync(f.cache), false)
})

test('completed package cache is reused without rewriting content', (t) => {
  const f = fixture(t)
  f.write('node_modules/native/index.js', 'module.exports = __dirname')
  f.write('node_modules/native/binding.node', 'not loaded')
  f.load('native')
  const filename = path.join(f.cache, 'node_modules/native/binding.node')
  const before = fs.statSync(filename).mtimeMs
  const second = register(f.archive, f.cache)
  assert.equal(second, f.hook)
  assert.equal(f.load('native'), path.join(f.cache, 'node_modules/native'))
  assert.equal(fs.statSync(filename).mtimeMs, before)
  f.hook.deregister()
  f.hook = register(f.archive, f.cache)
  delete require.cache[path.join(f.cache, 'node_modules/native/index.js')]
  assert.equal(f.load('native'), path.join(f.cache, 'node_modules/native'))
  assert.equal(fs.statSync(filename).mtimeMs, before)
})

test('ESM native package resolves its missing JavaScript dependency from archive', async (t) => {
  const f = fixture(t)
  f.write('node_modules/dep/package.json', JSON.stringify({ type: 'module', main: 'index.js' }))
  f.write('node_modules/dep/index.js', 'export default "archived"')
  const entry = f.write('node_modules/native/index.mjs', 'import dep from "dep"; export default dep')
  f.write('node_modules/native/binding.node', 'not loaded')
  const loaded = await import(pathToFileURL(entry).href)
  assert.equal(loaded.default, 'archived')
  assert.equal(fs.existsSync(path.join(f.cache, 'node_modules/dep')), false)
})

test('native package missing dependency reports MODULE_NOT_FOUND', (t) => {
  const f = fixture(t)
  f.write('node_modules/native/index.js', 'module.exports = require("missing-native-dependency")')
  f.write('node_modules/native/binding.node', 'not loaded')
  assert.throws(() => f.load('native'), { code: 'MODULE_NOT_FOUND' })
})

test('materialization preserves symbolic directory links', (t) => {
  const f = fixture(t)
  f.write('node_modules/native/index.js', 'module.exports = __dirname')
  f.write('node_modules/native/binding.node', 'not loaded')
  const resource = f.write('node_modules/native/resources/data.txt', 'linked data')
  const link = path.join(f.archive, 'node_modules/native/linked')
  fs.symlinkSync(process.platform === 'win32' ? path.dirname(resource) : 'resources', link, process.platform === 'win32' ? 'junction' : 'dir')
  f.load('native')
  const copied = path.join(f.cache, 'node_modules/native/linked')
  assert.equal(fs.lstatSync(copied).isSymbolicLink(), true)
  assert.equal(fs.readlinkSync(copied), fs.readlinkSync(link))
  assert.equal(fs.readFileSync(path.join(copied, 'data.txt'), 'utf8'), 'linked data')
})

test('materialization keeps relative directory links valid after staging is renamed', (t) => {
  const f = fixture(t)
  f.write('node_modules/native/index.js', 'module.exports = __dirname')
  f.write('node_modules/native/binding.node', 'not loaded')
  f.write('node_modules/native/resources/data.txt', 'relative link data')
  const link = path.join(f.archive, 'node_modules/native/linked')
  fs.symlinkSync(process.platform === 'win32' ? path.join(f.archive, 'node_modules/native/resources') : 'resources', link, process.platform === 'win32' ? 'junction' : 'dir')
  if (process.platform === 'win32') {
    const readlink = fs.readlinkSync
    t.mock.method(fs, 'readlinkSync', function readlinkSync(filename, ...args) {
      return filename === link ? 'resources' : Reflect.apply(readlink, this, [filename, ...args])
    })
  }
  f.load('native')
  const copied = path.join(f.cache, 'node_modules/native/linked')
  assert.equal(fs.realpathSync(copied), path.join(f.cache, 'node_modules/native/resources'))
  assert.equal(fs.readFileSync(path.join(copied, 'data.txt'), 'utf8'), 'relative link data')
})

test('archive JavaScript child receives preload when launched without inherited execArgv', (t) => {
  const f = fixture(t)
  f.write('node_modules/native/index.js', 'module.exports = __dirname')
  f.write('node_modules/native/binding.node', 'not loaded')
  const entry = f.write('child.cjs', 'process.stdout.write(require("native"))')
  const result = childProcess.spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, path.join(f.cache, 'node_modules/native'))
})

test('forked archive JavaScript receives preload with explicit empty execArgv', { timeout: 15000 }, async (t) => {
  const f = fixture(t)
  f.write('node_modules/native/index.js', 'module.exports = __dirname')
  f.write('node_modules/native/binding.node', 'not loaded')
  const entry = f.write('fork.cjs', 'process.send(require("native"))')
  const child = childProcess.fork(entry, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('message', resolve)
    child.once('exit', (code) => {
      if (code !== 0)
        reject(new Error(`fork exit=${code}`))
    })
  })
  assert.equal(result, path.join(f.cache, 'node_modules/native'))
})

test('worker inherits preload and resolves its native package in cache', { timeout: 15000 }, async (t) => {
  const f = fixture(t)
  f.write('node_modules/native/index.js', 'module.exports = __dirname')
  f.write('node_modules/native/binding.node', 'not loaded')
  const entry = f.write('worker.cjs', 'require("node:worker_threads").parentPort.postMessage(require("native"))')
  const worker = new (require('node:worker_threads').Worker)(entry)
  const result = await new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
  })
  assert.equal(result, path.join(f.cache, 'node_modules/native'))
  await worker.terminate()
})

test('file URL fork returns IPC from an ordinary script without changing global APIs after deregistration', { timeout: 15000 }, async (t) => {
  const workerThreads = require('node:worker_threads')
  const before = { ...childProcess, Worker: workerThreads.Worker }
  const f = fixture(t)
  const entry = path.join(path.dirname(f.archive), 'ordinary child.cjs')
  fs.writeFileSync(entry, 'process.send("DSH_FILE_FORK_OK")')
  const child = childProcess.fork(pathToFileURL(entry), { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  try {
    const [message, exit] = await Promise.all([once(child, 'message'), once(child, 'exit')])
    assert.deepEqual(message, ['DSH_FILE_FORK_OK', undefined])
    assert.deepEqual(exit, [0, null])
  }
  finally {
    if (child.exitCode === null)
      child.kill()
    f.hook.deregister()
  }
  assert.deepEqual({ ...childProcess, Worker: workerThreads.Worker }, before)
})

test('data URL worker returns its message without changing global APIs after deregistration', { timeout: 15000 }, async (t) => {
  const workerThreads = require('node:worker_threads')
  const before = { ...childProcess, Worker: workerThreads.Worker }
  const f = fixture(t)
  const entry = new URL('data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.postMessage("DSH_DATA_WORKER_OK")')
  const worker = new workerThreads.Worker(entry)
  try {
    assert.deepEqual(await once(worker, 'message'), ['DSH_DATA_WORKER_OK'])
  }
  finally {
    await worker.terminate()
    f.hook.deregister()
  }
  assert.deepEqual({ ...childProcess, Worker: workerThreads.Worker }, before)
})

function concurrentMaterializer() {
  const fs = require('node:fs')
  const path = require('node:path')
  const { parentPort, workerData } = require('node:worker_threads')
  const exists = fs.existsSync
  let paused = false
  fs.existsSync = function existsSync(filename) {
    const result = exists(filename)
    if (!paused && filename === path.join(workerData.cache, 'node_modules', workerData.specifier, '.dsh-native-complete')) {
      paused = true
      parentPort.postMessage('ready')
      Atomics.wait(new Int32Array(workerData.gate), workerData.index, 0)
    }
    return result
  }
  require(workerData.preload)(workerData.archive, workerData.cache)
  const load = require('node:module').createRequire(path.join(workerData.archive, 'entry.cjs'))
  const loaded = load(workerData.specifier)
  let directory = loaded
  if (workerData.specifier === 'koffi') {
    const pid = loaded.load('kernel32.dll').func('uint32_t __stdcall GetCurrentProcessId()')()
    require('node:assert/strict').equal(pid, require('node:process').pid)
    directory = path.dirname(Object.values(require.cache).find(entry => entry.exports === loaded).filename)
  }
  parentPort.postMessage(directory)
}

async function raceMaterializers(t, archive, cache, specifier) {
  const gate = new SharedArrayBuffer(8)
  const workers = [0, 1].map(index => new Worker(`(${concurrentMaterializer.toString()})()`, {
    eval: true,
    execArgv: [],
    env: { ...process.env, DSH_CORE_ARCHIVE: archive, DSH_CORE_NATIVE_CACHE: cache },
    workerData: { index, gate, specifier, preload: require.resolve('./asar-native.cjs'), archive, cache },
  }))
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.terminate()))
  })
  await Promise.all(workers.map(worker => once(worker, 'message').then(([message]) => assert.equal(message, 'ready'))))
  const loaded = once(workers[0], 'message')
  Atomics.store(new Int32Array(gate), 0, 1)
  Atomics.notify(new Int32Array(gate), 0)
  const [destination] = await loaded
  assert.equal(destination, path.join(cache, 'node_modules', specifier))
  const sentinel = path.join(destination, 'loaded.txt')
  fs.writeFileSync(sentinel, 'already loaded')
  const second = once(workers[1], 'message')
  Atomics.store(new Int32Array(gate), 1, 1)
  Atomics.notify(new Int32Array(gate), 1)
  assert.deepEqual(await second, [destination])
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'already loaded')
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), [specifier])
}

test('concurrent first materializers reuse the published package without removing loaded files', { timeout: 15000 }, async (t) => {
  const f = fixture(t)
  f.write('node_modules/native/index.js', 'module.exports = __dirname')
  f.write('node_modules/native/binding.node', 'not loaded')
  await raceMaterializers(t, f.archive, f.cache, 'native')
})

test('nested native package loaded before its native parent survives parent publication', (t) => {
  const f = fixture(t)
  f.write('node_modules/koffi/index.js', 'module.exports = __dirname')
  f.write('node_modules/koffi/node_modules/nested/index.js', 'module.exports = __dirname')
  f.write('node_modules/koffi/node_modules/nested/binding.node', 'not loaded')
  const nested = createRequire(path.join(f.archive, 'node_modules/koffi/entry.cjs'))('nested')
  const sentinel = path.join(nested, 'loaded.txt')
  fs.writeFileSync(sentinel, 'nested already loaded')
  assert.equal(f.load('koffi'), path.join(f.cache, 'node_modules/koffi'))
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'nested already loaded')
  assert.equal(fs.readFileSync(path.join(nested, 'binding.node'), 'utf8'), 'not loaded')
})

test('ordinary Node eval child receives no preload argument', (t) => {
  fixture(t)
  const result = childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.execArgv))'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ['-e', 'process.stdout.write(JSON.stringify(process.execArgv))'])
})

test('promisified execFile retains stdout, stderr and the child process', async (t) => {
  fixture(t)
  const pending = promisify(childProcess.execFile)(process.execPath, ['-e', 'process.stdout.write("cloudflared version 2026.10.7\\n"); process.stderr.write("diagnostic")'], { timeout: 5000 })
  assert.equal(typeof pending.child.pid, 'number')
  assert.deepEqual(await pending, { stdout: 'cloudflared version 2026.10.7\n', stderr: 'diagnostic' })
})

test('promisified execFile preserves failure output and exit status', async (t) => {
  fixture(t)
  const pending = promisify(childProcess.execFile)(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7'], { timeout: 5000 })
  await assert.rejects(pending, { code: 7, stdout: 'out', stderr: 'err' })
})

test('promisified execFile redirects archived Node children through the bridge', async (t) => {
  const f = fixture(t)
  f.write('node_modules/native/index.js', 'module.exports = __dirname')
  f.write('node_modules/native/binding.node', 'not loaded')
  const entry = f.write('child.cjs', 'process.stdout.write(require("native"))')
  const result = await promisify(childProcess.execFile)(process.execPath, [entry], { timeout: 5000 })
  assert.equal(result.stdout, path.join(f.cache, 'node_modules/native'))
  assert.equal(result.stderr, '')
})

if (process.env.DSH_ASAR_NATIVE_INTEGRATION === '1') {
  const archive = path.resolve(process.env.DSH_ASAR_TEST_ARCHIVE || '.temp/pkg/deepseek-harness-pkg-windows.asar')
  const cache = fs.mkdtempSync(path.join(scratch, 'integration-'))
  const load = createRequire(path.join(archive, 'native-test.cjs'))
  const hook = register(archive, cache)
  require('node:test').after(() => hook.deregister())

  for (const target of ['session koffi', 'sharp']) {
    test(`HMR pre-resolution loads real archived ${target} from a cold cache`, { timeout: 30000 }, () => {
      const coldCache = fs.mkdtempSync(path.join(scratch, 'hmr-real-'))
      const result = childProcess.spawnSync(process.execPath, ['--require', require.resolve('./asar-native.cjs'), '-e', `
        const assert = require('node:assert/strict')
        const { createRequire, Module } = require('node:module')
        const path = require('node:path')
        const archive = process.env.DSH_CORE_ARCHIVE
        const load = createRequire(path.join(archive, 'probe.cjs'))
        const nativeLoad = Module._load
        Module._load = function (request, parent, isMain, ...options) {
          const filename = Module.isBuiltin(request) ? request : Module._resolveFilename(request, parent, isMain)
          return nativeLoad.call(this, filename, parent, isMain, ...options)
        }
        ;(async () => {
          if (process.env.DSH_ASAR_TEST_TARGET === 'session koffi') {
            const sessionLoad = createRequire(path.join(archive, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/probe.cjs'))
            const koffi = sessionLoad('koffi')
            const library = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6')
            assert.equal(library.func(process.platform === 'win32' ? 'uint32_t __stdcall GetCurrentProcessId()' : 'int getpid()')(), process.pid)
            return
          }
          const sharp = load('sharp')
          const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer()
          assert.equal(png.subarray(1, 4).toString(), 'PNG')
          const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
          assert.equal(info.width, 3)
          assert.equal(info.height, 2)
          assert.deepEqual([...data.subarray(0, 4)], [255, 0, 0, 255])
        })().catch(error => { console.error(error); process.exitCode = 1 })
      `], { encoding: 'utf8', timeout: 25000, env: { ...process.env, DSH_CORE_ARCHIVE: archive, DSH_CORE_NATIVE_CACHE: coldCache, DSH_ASAR_TEST_TARGET: target } })
      assert.equal(result.status, 0, result.stderr)
    })
  }

  test('real asar directory links retain their resource target during materialization', (t) => {
    const f = fixture(t)
    const linkedArchive = path.join(fs.mkdtempSync(path.join(scratch, 'asar-link-')), 'linked.asar')
    const index = Buffer.from('module.exports = __dirname')
    const binding = Buffer.from('not loaded')
    const data = Buffer.from('linked asar data')
    const native = { files: {
      'index.js': { size: index.length, offset: '0' },
      'binding.node': { size: binding.length, offset: String(index.length) },
      'resources': { files: { 'data.txt': { size: data.length, offset: String(index.length + binding.length) } } },
      'linked': { link: 'node_modules/native/resources' },
    } }
    const json = Buffer.from(JSON.stringify({ files: { node_modules: { files: { native } } } }))
    const padded = Math.ceil(json.length / 4) * 4
    const header = Buffer.alloc(16)
    header.writeUInt32LE(4, 0)
    header.writeUInt32LE(padded + 8, 4)
    header.writeUInt32LE(padded + 4, 8)
    header.writeUInt32LE(json.length, 12)
    require('original-fs').writeFileSync(linkedArchive, Buffer.concat([header, json, Buffer.alloc(padded - json.length), index, binding, data]))
    const hook = register(linkedArchive, f.cache)
    t.after(() => hook.deregister())
    const load = createRequire(path.join(linkedArchive, 'entry.cjs'))
    assert.equal(load('native'), path.join(f.cache, 'node_modules/native'))
    assert.equal(fs.readFileSync(path.join(f.cache, 'node_modules/native/linked/data.txt'), 'utf8'), 'linked asar data')
  })

  test('concurrent real archived koffi loaders keep the published DLL package intact', { timeout: 15000 }, async (t) => {
    const concurrentCache = fs.mkdtempSync(path.join(scratch, 'concurrent-real-'))
    await raceMaterializers(t, archive, concurrentCache, 'koffi')
  })

  test('real archived sharp generates PNG pixels through the physical native package', async () => {
    const sharp = load('sharp')
    const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer()
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 3)
    assert.equal(info.height, 2)
    assert.deepEqual([...data.subarray(0, 4)], [255, 0, 0, 255])
    assert.equal(fs.existsSync(path.join(cache, 'node_modules/@deepseek-ai/dsh')), false)
  })

  test('real archived koffi calls the operating system process ID function', () => {
    const koffi = load('koffi')
    const library = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6')
    const pid = library.func(process.platform === 'win32' ? 'uint32_t __stdcall GetCurrentProcessId()' : 'int getpid()')()
    assert.equal(pid, process.pid)
  })

  test('real nested koffi keeps its own native version beside the root package', () => {
    const nestedRoot = path.join(archive, 'node_modules/@deepseek-ai/dsh-fs-local/node_modules')
    const nested = createRequire(path.join(nestedRoot, 'probe.cjs'))('koffi')
    assert.equal(load('koffi').version, JSON.parse(fs.readFileSync(path.join(archive, 'node_modules/koffi/package.json'), 'utf8')).version)
    assert.equal(nested.version, JSON.parse(fs.readFileSync(path.join(nestedRoot, 'koffi/package.json'), 'utf8')).version)
    const library = nested.load(process.platform === 'win32' ? 'kernel32.dll' : process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6')
    assert.equal(library.func(process.platform === 'win32' ? 'uint32_t __stdcall GetCurrentProcessId()' : 'int getpid()')(), process.pid)
  })

  test('archived ripgrep executable runs from a complete physical package', () => {
    const executable = path.join(archive, `node_modules/@vscode/ripgrep-${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
    const result = childProcess.spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^ripgrep 15\./)
    assert.equal(fs.existsSync(path.join(cache, path.relative(archive, executable))), true)
  })

  test('real archived node-pty produces command output with a real process and successful exit', { timeout: 15000 }, async (t) => {
    const pty = load('node-pty')
    const windows = process.platform === 'win32'
    const term = pty.spawn(windows ? process.env.ComSpec : '/bin/sh', windows ? ['/d', '/q', '/c', 'echo DSH_NATIVE_PTY_OK'] : ['-c', 'printf DSH_NATIVE_PTY_OK'], { cwd: path.resolve('.temp/native-home'), env: process.env, cols: 80, rows: 24 })
    t.after(() => term.kill())
    let output = ''
    term.onData((data) => {
      output += data
    })
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        term.kill()
        reject(new Error(`terminal timed out: ${output}`))
      }, 10000)
      term.onExit((event) => {
        clearTimeout(timer)
        resolve(event.exitCode)
      })
    })
    assert.ok(term.pid > 0)
    assert.equal(exitCode, 0, output)
    assert.match(output, /DSH_NATIVE_PTY_OK/)
  })
}
