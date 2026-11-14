'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const { createRequire, Module, registerHooks, syncBuiltinESMExports } = require('node:module')
const path = require('node:path')
const process = require('node:process')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { promisify } = require('node:util')
const workerThreads = require('node:worker_threads')

const CACHE_VERSION = '2'
const registrations = new Map()

module.exports = function registerNativePackages(archive, cache) {
  archive = path.resolve(archive)
  cache = path.resolve(cache)
  const key = `${archive}\0${cache}`
  if (registrations.has(key))
    return registrations.get(key)
  const packages = new Map()
  const completed = new Set()
  const archived = archive.endsWith('.asar')

  function relative(root, filename) {
    const result = path.relative(root, filename)
    if (result === '' || (!result.startsWith(`..${path.sep}`) && result !== '..' && !path.isAbsolute(result)))
      return result
    return null
  }

  // 提升依赖复制进物化目录后，路径不再与归档一一对应（cache/<pkg>/node_modules/a 来自
  // 归档根 node_modules/a）。这里记录副本 → 真实来源，才能让 resolve hook 还原到存在的文件。
  const sources = new Map()

  function original(filename) {
    let best
    for (const [copy, source] of sources) {
      const entry = relative(copy, filename)
      if (entry !== null && (best === undefined || copy.length > best.copy.length))
        best = { copy, source, entry }
    }
    if (best)
      return path.join(best.source, best.entry)
    const entry = relative(cache, filename)
    return entry === null ? filename : path.join(archive, entry)
  }

  function packageRoot(filename) {
    const entry = relative(archive, filename)
    if (entry === null)
      return null
    const parts = entry.split(path.sep)
    const index = parts.lastIndexOf('node_modules')
    if (index < 0 || !parts[index + 1])
      return null
    const end = index + (parts[index + 1].startsWith('@') ? 3 : 2)
    if (parts.length < end)
      return null
    return path.join(archive, ...parts.slice(0, end))
  }

  function hasNativeResources(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
    entries.sort((a, b) => Number(/^(?:bin|build|prebuilds|lib)$/.test(b.name)) - Number(/^(?:bin|build|prebuilds|lib)$/.test(a.name)))
    for (const entry of entries) {
      if (entry.name === 'node_modules')
        continue
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (hasNativeResources(filename))
          return true
      }
      else if (/\.(?:node|dll|dylib|exe)$|\.so(?:\.|$)/i.test(entry.name) || (path.basename(directory) === 'bin' && !path.extname(entry.name))) {
        return true
      }
    }
    return false
  }

  function isNative(root) {
    if (packages.has(root))
      return packages.get(root)
    const name = path.basename(root)
    const native = name === 'node-pty' || name === 'sharp' || name === 'koffi' || hasNativeResources(root)
    packages.set(root, native)
    return native
  }

  const refused = new Set()
  function refuse(name, message, log) {
    if (!refused.has(name)) {
      refused.add(name)
      console.error(log)
    }
    throw Object.assign(new Error(message), { code: 'ERR_DSH_SHARP_ELECTRON_LINUX' })
  }

  function refuseElectronLinuxSharp(root) {
    if (process.platform !== 'linux' || process.versions.electron === undefined)
      return
    const base = path.basename(root)
    if (base === 'sharp') {
      if (!fs.existsSync(path.join(archive, 'node_modules', '@img', 'sharp-wasm32'))) {
        refuse(
          'sharp',
          `sharp is disabled under Electron on Linux: its prebuilt native decoders conflict with Electron's bundled glibc and terminate the Harness process (issue #1504). Reinstalling or rebuilding sharp cannot fix this: image features are unavailable, and every other feature keeps working.`,
          `[asar-native] refusing sharp: the archive carries no @img/sharp-wasm32 fallback, so image decoding stays unavailable under Electron on Linux and reinstalling sharp cannot help (issue #1504)`,
        )
      }
      return
    }
    if (path.basename(path.dirname(root)) !== '@img' || !/^sharp-(?:libvips-)?linux/.test(base))
      return
    const name = `@img/${base}`
    refuse(
      name,
      `${name} is disabled under Electron on Linux: its prebuilt binaries conflict with Electron's bundled glibc and terminate the Harness process (issue #1490)`,
      `[asar-native] refusing ${name}: Electron's bundled glibc conflicts with sharp's prebuilt Linux binaries and terminates the Harness process, so image decoders stay unavailable (issue #1490)`,
    )
  }

  function copy(source, destination, excludeNodeModules = true) {
    const stat = fs.lstatSync(source)
    if (stat.isSymbolicLink()) {
      if (archived) {
        copy(fs.realpathSync(source), destination, excludeNodeModules)
        return
      }
      let target = fs.readlinkSync(source)
      const directory = fs.statSync(source).isDirectory()
      if (directory && process.platform === 'win32' && !path.isAbsolute(target)) {
        target = path.resolve(path.dirname(path.join(cache, path.relative(archive, source))), target)
      }
      fs.symlinkSync(target, destination, directory ? process.platform === 'win32' ? 'junction' : 'dir' : 'file')
    }
    else if (stat.isDirectory()) {
      fs.mkdirSync(destination, { recursive: true })
      for (const entry of fs.readdirSync(source)) {
        if (entry !== 'node_modules' || !excludeNodeModules)
          copy(path.join(source, entry), path.join(destination, entry), excludeNodeModules)
      }
      fs.chmodSync(destination, stat.mode)
    }
    else {
      fs.writeFileSync(destination, fs.readFileSync(source), { mode: stat.mode })
      fs.chmodSync(destination, stat.mode)
    }
  }

  function declarations(root) {
    const declared = new Map()
    const filename = path.join(root, 'package.json')
    if (fs.existsSync(filename)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
        for (const field of [manifest.dependencies, manifest.optionalDependencies]) {
          if (field && typeof field === 'object') {
            for (const name of Object.keys(field)) declared.set(name, name.split('/'))
          }
        }
      }
      catch {}
    }
    const nested = path.join(root, 'node_modules')
    if (fs.existsSync(nested)) {
      for (const entry of fs.readdirSync(nested)) {
        if (entry.startsWith('.'))
          continue
        if (!entry.startsWith('@')) {
          if (!declared.has(entry))
            declared.set(entry, [entry])
          continue
        }
        const scope = path.join(nested, entry)
        for (const name of fs.readdirSync(scope)) {
          if (!name.startsWith('.'))
            declared.set(`${entry}/${name}`, [entry, name])
        }
      }
    }
    return declared
  }

  function locate(root, segments) {
    const inside = path.join(root, 'node_modules', ...segments)
    if (fs.existsSync(inside))
      return inside
    const entry = relative(archive, root)
    if (entry === null)
      return null
    const parts = entry === '' ? [] : entry.split(path.sep)
    for (let index = parts.length - 1; index >= 0; index--) {
      const candidate = path.join(archive, ...parts.slice(0, index), 'node_modules', ...segments)
      if (fs.existsSync(candidate))
        return candidate
    }
    return null
  }

  /// 依赖按「解析到它的那个包」的私有目录落地：owner 的目录相对归档的路径 P 对应
  /// staging/P，于是依赖落 staging/P/node_modules/<name>，与 node 在归档里的查找顺序
  /// 完全一致。按来源目录而不是包名去重，两个版本因此各留一份，不会互相顶掉。
  ///
  /// 返回「相对 staging 的副本路径 → 归档内真实来源」，物化完成后由调用方登记到 sources。
  function hoist(root, staging) {
    const handled = new Set()
    const copies = []
    const pending = [{ directory: root, target: staging }]
    while (pending.length > 0) {
      const { directory, target } = pending.shift()
      for (const [, segments] of declarations(directory)) {
        const source = locate(directory, segments)
        if (!source || handled.has(source))
          continue
        handled.add(source)
        const destination = path.join(target, 'node_modules', ...segments)
        // 包自身的 node_modules 已由 copy(root, staging, false) 原样带入，这里只补
        // 被提升到归档根、因此不在私有目录里的那些；重复写同一目标会让 publish 的
        // rename 撞上仍被打开的文件（Windows 上表现为 EPERM）。
        if (!fs.existsSync(destination)) {
          fs.mkdirSync(path.dirname(destination), { recursive: true })
          copy(source, destination, false)
          copies.push({ relative: path.relative(staging, destination), source })
        }
        pending.push({ directory: source, target: destination })
      }
    }
    return copies
  }

  function complete(destination) {
    const marker = path.join(destination, '.dsh-native-complete')
    if (!fs.existsSync(marker))
      return false
    try {
      return fs.readFileSync(marker, 'utf8') === CACHE_VERSION
    }
    catch {
      return false
    }
  }

  function publish(staging, destination) {
    if (fs.existsSync(destination) && !complete(destination))
      fs.rmSync(destination, { recursive: true, force: true })
    try {
      fs.renameSync(staging, destination)
    }
    catch (error) {
      if (!complete(destination))
        throw error
    }
  }

  function materialize(root) {
    const entry = path.relative(archive, root)
    const destination = path.join(cache, entry)
    if (completed.has(root))
      return destination
    if (!complete(destination)) {
      const parts = entry.split(path.sep)
      for (let index = 0; index < parts.length; index++) {
        if (parts[index] !== 'node_modules')
          continue
        const ancestor = packageRoot(path.join(archive, ...parts.slice(0, index)))
        if (ancestor && isNative(ancestor))
          materialize(ancestor)
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      const staging = fs.mkdtempSync(`${destination}.stage-`)
      try {
        copy(root, staging, false)
        const copies = hoist(root, staging)
        fs.writeFileSync(path.join(staging, '.dsh-native-complete'), CACHE_VERSION)
        publish(staging, destination)
        for (const copy of copies)
          sources.set(path.join(destination, copy.relative), copy.source)
      }
      finally {
        fs.rmSync(staging, { recursive: true, force: true })
      }
    }
    completed.add(root)
    return destination
  }

  // HMR 会在同步 resolve hook 之前预解析 require，必须先还原缓存模块的依赖查找位置。
  const resolveFilename = Module._resolveFilename
  function resolveFromArchive(request, parent, ...options) {
    if (parent?.filename) {
      const filename = original(parent.filename)
      if (filename !== parent.filename)
        parent = Object.assign(Object.create(parent), { filename, paths: parent.paths?.map(original) })
    }
    return resolveFilename.call(this, request, parent, ...options)
  }
  Module._resolveFilename = resolveFromArchive

  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      let parentURL = context.parentURL
      if (parentURL?.startsWith('file:')) {
        const parent = fileURLToPath(parentURL)
        const sourceParent = original(parent)
        parentURL = pathToFileURL(sourceParent).href
        if (parent !== sourceParent && context.conditions.includes('require'))
          specifier = createRequire(parentURL).resolve(specifier)
      }
      if (specifier.startsWith('file:'))
        specifier = pathToFileURL(original(fileURLToPath(specifier))).href
      else if (path.isAbsolute(specifier))
        specifier = original(specifier)
      const result = nextResolve(specifier, { ...context, parentURL })
      if (!result.url.startsWith('file:'))
        return result
      const filename = fileURLToPath(result.url)
      const root = packageRoot(filename)
      if (!root || !isNative(root))
        return result
      refuseElectronLinuxSharp(root)
      return { ...result, url: pathToFileURL(path.join(materialize(root), path.relative(root, filename))).href }
    },
  })

  function inside(filename) {
    const resolved = path.resolve(filename)
    return relative(archive, resolved) !== null || relative(cache, resolved) !== null
  }

  function entrypoint(filename, candidates) {
    const source = filename instanceof URL ? (filename.protocol === 'file:' ? fileURLToPath(filename) : null) : filename
    if (typeof source === 'string' && inside(source))
      return true
    return candidates.some(arg => typeof arg === 'string' && /\.[cm]?js$/.test(arg) && inside(arg))
  }

  function environment(options) {
    return { ...options, env: { ...(options.env || process.env), DSH_CORE_ARCHIVE: archive, DSH_CORE_NATIVE_CACHE: cache } }
  }

  function wrapChildProcess(name, method) {
    return function nativeChildProcess(filename, args, ...rest) {
      if (name === 'fork' && !Array.isArray(args)) {
        rest.unshift(args)
        args = []
      }
      if (name === 'fork') {
        if (entrypoint(filename, []) && (!rest[0]?.execPath || path.resolve(rest[0].execPath) === process.execPath)) {
          const options = rest[0] || {}
          rest[0] = environment({ ...options, execArgv: [...(options.execArgv || process.execArgv)] })
          if (!rest[0].execArgv.includes(__filename))
            rest[0].execArgv.push('--require', __filename)
        }
      }
      else if (path.resolve(filename) === process.execPath && Array.isArray(args) && entrypoint(null, args)) {
        args = [...args]
        if (!args.includes(__filename))
          args.unshift('--require', __filename)
        if (typeof rest[0] === 'function')
          rest.unshift({})
        rest[0] = environment(rest[0] || {})
      }
      else {
        const root = packageRoot(filename)
        if (root)
          filename = path.join(materialize(root), path.relative(root, filename))
      }
      return Reflect.apply(method, this, [filename, args, ...rest])
    }
  }
  const methods = new Map()
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const method = childProcess[name]
    methods.set(name, method)
    childProcess[name] = wrapChildProcess(name, method)
    if (method[promisify.custom]) {
      Object.defineProperty(childProcess[name], promisify.custom, {
        value: wrapChildProcess(name, method[promisify.custom]),
      })
    }
  }
  const Worker = workerThreads.Worker
  workerThreads.Worker = class extends Worker {
    constructor(filename, options = {}) {
      if (!options.eval && entrypoint(filename, [])) {
        const execArgv = [...(options.execArgv || [])]
        if (!execArgv.includes(__filename))
          execArgv.push('--require', __filename)
        options = { ...options, execArgv }
      }
      super(filename, options)
    }
  }
  syncBuiltinESMExports()
  const execArgv = [...process.execArgv]
  for (let index = 0; index < process.execArgv.length; index++) {
    const arg = process.execArgv[index]
    if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print' || arg === '--input-type')
      process.execArgv.splice(index--, 2)
    else if (arg.startsWith('--input-type=') || arg.startsWith('--eval='))
      process.execArgv.splice(index--, 1)
  }
  if (!process.execArgv.includes(__filename))
    process.execArgv.push('--require', __filename)
  function handOffWindowsRunner() {
    if (process.env.DSH_SUBPROCESS_RUNNER !== 'windows')
      return
    const delimiter = process.argv.indexOf('--', 1)
    const program = delimiter < 0 ? undefined : process.argv[delimiter + 1]
    if (program === undefined || path.resolve(program) !== process.execPath)
      return
    const target = process.argv.slice(delimiter + 2)
    if (target.includes(__filename))
      return
    if (!entrypoint(null, target))
      return
    process.argv.splice(delimiter + 2, 0, '--require', __filename)
  }
  const previousArchive = process.env.DSH_CORE_ARCHIVE
  const previousCache = process.env.DSH_CORE_NATIVE_CACHE
  process.env.DSH_CORE_ARCHIVE = archive
  process.env.DSH_CORE_NATIVE_CACHE = cache
  handOffWindowsRunner()
  const registration = {
    deregister() {
      if (!registrations.has(key))
        return
      hook.deregister()
      if (Module._resolveFilename === resolveFromArchive)
        Module._resolveFilename = resolveFilename
      for (const [name, method] of methods) childProcess[name] = method
      workerThreads.Worker = Worker
      syncBuiltinESMExports()
      process.execArgv.splice(0, process.execArgv.length, ...execArgv)
      if (previousArchive === undefined)
        delete process.env.DSH_CORE_ARCHIVE
      else process.env.DSH_CORE_ARCHIVE = previousArchive
      if (previousCache === undefined)
        delete process.env.DSH_CORE_NATIVE_CACHE
      else process.env.DSH_CORE_NATIVE_CACHE = previousCache
      registrations.delete(key)
    },
  }
  registrations.set(key, registration)
  return registration
}

if (process.env.DSH_CORE_ARCHIVE && process.env.DSH_CORE_NATIVE_CACHE) {
  module.exports(process.env.DSH_CORE_ARCHIVE, process.env.DSH_CORE_NATIVE_CACHE)
}
