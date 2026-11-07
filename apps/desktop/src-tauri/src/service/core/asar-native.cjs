'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const { createRequire, Module, registerHooks, syncBuiltinESMExports } = require('node:module')
const path = require('node:path')
const process = require('node:process')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { promisify } = require('node:util')
const workerThreads = require('node:worker_threads')

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

  function original(filename) {
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

  function copy(source, destination) {
    const stat = fs.lstatSync(source)
    if (stat.isSymbolicLink()) {
      if (archived) {
        copy(fs.realpathSync(source), destination)
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
        if (entry !== 'node_modules')
          copy(path.join(source, entry), path.join(destination, entry))
      }
      fs.chmodSync(destination, stat.mode)
    }
    else {
      fs.writeFileSync(destination, fs.readFileSync(source), { mode: stat.mode })
      fs.chmodSync(destination, stat.mode)
    }
  }

  function materialize(root) {
    const entry = path.relative(archive, root)
    const destination = path.join(cache, entry)
    if (completed.has(root))
      return destination
    const marker = path.join(destination, '.dsh-native-complete')
    if (!fs.existsSync(marker)) {
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
        copy(root, staging)
        fs.writeFileSync(path.join(staging, '.dsh-native-complete'), '1')
        try {
          fs.renameSync(staging, destination)
        }
        catch (error) {
          if (!fs.existsSync(marker))
            throw error
        }
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
      if (filename !== parent.filename) {
        parent = Object.assign(Object.create(parent), { filename, paths: parent.paths?.map(original) })
      }
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
        if (parent !== sourceParent && context.conditions.includes('require')) {
          specifier = createRequire(parentURL).resolve(specifier)
        }
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
      return { ...result, url: pathToFileURL(path.join(materialize(root), path.relative(root, filename))).href }
    },
  })
  function wrapChildProcess(name, method) {
    return function nativeChildProcess(filename, args, ...rest) {
      if (name === 'fork' && !Array.isArray(args)) {
        rest.unshift(args)
        args = []
      }
      if (name === 'fork') {
        const source = original(filename instanceof URL ? fileURLToPath(filename) : filename)
        if (relative(archive, source) !== null && (!rest[0]?.execPath || path.resolve(rest[0].execPath) === process.execPath)) {
          const options = rest[0] || {}
          rest[0] = { ...options, execArgv: [...(options.execArgv || process.execArgv)], env: { ...(options.env || process.env), DSH_CORE_ARCHIVE: archive, DSH_CORE_NATIVE_CACHE: cache } }
          if (!rest[0].execArgv.includes(__filename))
            rest[0].execArgv.push('--require', __filename)
        }
      }
      else if (path.resolve(filename) === process.execPath && Array.isArray(args) && args.some(arg => typeof arg === 'string' && /\.[cm]?js$/.test(arg) && relative(archive, path.resolve(arg)) !== null)) {
        args = [...args]
        if (!args.includes(__filename))
          args.unshift('--require', __filename)
        if (typeof rest[0] === 'function')
          rest.unshift({})
        const options = rest[0] || {}
        rest[0] = { ...options, env: { ...(options.env || process.env), DSH_CORE_ARCHIVE: archive, DSH_CORE_NATIVE_CACHE: cache } }
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
      const source = filename instanceof URL ? (filename.protocol === 'file:' ? fileURLToPath(filename) : null) : filename
      if (!options.eval && typeof source === 'string' && relative(archive, original(path.resolve(source))) !== null) {
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
  const previousArchive = process.env.DSH_CORE_ARCHIVE
  const previousCache = process.env.DSH_CORE_NATIVE_CACHE
  process.env.DSH_CORE_ARCHIVE = archive
  process.env.DSH_CORE_NATIVE_CACHE = cache
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
