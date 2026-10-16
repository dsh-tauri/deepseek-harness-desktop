#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

const MANIFEST_MAX_BYTES = 64 * 1024
const SPRITESHEET_MAX_BYTES = 8 * 1024 * 1024
const SPRITESHEET_MAX_DIMENSION = 16384
const SPRITESHEET_MAX_PIXELS = 64 * 1024 * 1024
const COLUMNS = 8
const V1_ROWS = 9
const V2_ROWS = 11
const ID_PATTERN = /^[\w-]{1,64}$/

const problems = []
const notes = []

function fail(message) {
  problems.push(message)
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || /[^\w-]/.test(id)) {
    fail('PET_ID_INVALID: id must be 1..=64 ascii letters/digits/-/_')
    return false
  }
  return true
}

function portableRelative(value, field = 'path') {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`PET_PATH_INVALID: ${field} must be a non-empty string`)
    return undefined
  }
  if (value.includes('\0') || value.includes('\\') || value.includes(':')) {
    fail('PET_PATH_INVALID: path must be a portable relative path')
    return undefined
  }
  const normalized = value.replaceAll('/', sep)
  if (isAbsolute(normalized)) {
    fail('PET_PATH_INVALID: path must not be absolute or contain traversal')
    return undefined
  }
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    fail('PET_PATH_INVALID: path must not be absolute or contain traversal')
    return undefined
  }
  return normalized
}

function containedPath(directory, value, field, directoryOnly = false) {
  const portable = portableRelative(value, field)
  if (portable === undefined)
    return undefined
  try {
    const root = realpathSync(directory)
    const candidate = realpathSync(resolve(directory, portable))
    const inside = relative(root, candidate)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      fail(`PET_PATH_INVALID: ${field} escapes the pet directory`)
      return undefined
    }
    const stats = statSync(candidate)
    if (directoryOnly ? !stats.isDirectory() : !stats.isFile()) {
      fail(`PET_ASSET_READ_FAILED: ${field} must be a ${directoryOnly ? 'directory' : 'file'}`)
      return undefined
    }
    return candidate
  }
  catch (error) {
    fail(`PET_ASSET_READ_FAILED: ${field}: ${error.message}`)
    return undefined
  }
}

function readBounded(path, limit, prefix, read = true) {
  if (path === undefined)
    return undefined
  try {
    const stats = statSync(path)
    if (!stats.isFile() || stats.size === 0 || stats.size > limit) {
      fail(`${prefix}: ${path} must be a non-empty file of at most ${limit} bytes`)
      return undefined
    }
    if (!read)
      return stats.size
    const bytes = readFileSync(path)
    if (bytes.length > limit) {
      fail(`${prefix}: ${path} exceeds the ${limit} byte limit`)
      return undefined
    }
    return bytes
  }
  catch (error) {
    fail(`${prefix}: failed to read ${path}: ${error.message}`)
    return undefined
  }
}

function parseJsonc(bytes) {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
  const stripped = text.replace(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : ' ')
  return JSON.parse(stripped.replace(/"(?:\\[\s\S]|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : ''))
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function animationNames(config) {
  const names = new Set()
  function slot(value, field, empty = false) {
    const entries = typeof value === 'string' ? [value] : value
    if (!Array.isArray(entries) || (!empty && entries.length === 0)) {
      fail(`PET_CONFIG_INVALID: ${field} must be a string or ${empty ? '' : 'non-empty '}string array`)
      return
    }
    for (const name of entries) {
      if (portableRelative(name, field) === undefined || name.includes('/')) {
        fail(`PET_CONFIG_INVALID: ${field} must contain plain animation names`)
        continue
      }
      names.add(name)
    }
  }
  function motions(value, field) {
    if (!object(value)) {
      fail(`PET_CONFIG_INVALID: ${field} must be an object`)
      return
    }
    for (const [motion, entry] of Object.entries(value))
      slot(entry, `${field}.${motion}`)
  }
  if (config.motions !== undefined)
    motions(config.motions, 'motions')
  if (config.animations !== undefined) {
    const pools = config.animations
    if (!object(pools)) {
      fail('PET_CONFIG_INVALID: animations must be an object')
      return names
    }
    for (const key of ['idle', 'turn', 'drag', 'clicks']) {
      if (pools[key] !== undefined)
        slot(pools[key], `animations.${key}`, true)
    }
    if (pools.motions !== undefined)
      motions(pools.motions, 'animations.motions')
    if (pools.moves !== undefined) {
      if (!object(pools.moves) || !Array.isArray(pools.moves.actions)) {
        fail('PET_CONFIG_INVALID: animations.moves.actions must be an array')
      }
      else {
        for (const action of pools.moves.actions)
          slot(action?.name, 'animations.moves.actions.name')
      }
    }
    if (pools.categories !== undefined) {
      if (!Array.isArray(pools.categories)) {
        fail('PET_CONFIG_INVALID: animations.categories must be an array')
      }
      else {
        for (const category of pools.categories)
          slot(category?.actions, 'animations.categories.actions', true)
      }
    }
    if (pools.events !== undefined) {
      if (!object(pools.events)) {
        fail('PET_CONFIG_INVALID: animations.events must be an object')
      }
      else {
        for (const [event, slots] of Object.entries(pools.events)) {
          if (!Array.isArray(slots)) {
            fail(`PET_CONFIG_INVALID: animations.events.${event} must be an array`)
          }
          else {
            for (const value of slots)
              slot(value, `animations.events.${event}`, true)
          }
        }
      }
    }
  }
  if (names.size === 0)
    fail('PET_CONFIG_INVALID: motions or animations must reference at least one video')
  return names
}

function validateVideo(directory, manifest) {
  if (!object(manifest.ext) || manifest.ext.default !== 'webm' || (manifest.ext.mac !== undefined && !['webm', 'mov'].includes(manifest.ext.mac)))
    fail('PET_MANIFEST_INVALID: ext.default must be webm and ext.mac must be webm or mov')
  if (manifest.size !== undefined && (typeof manifest.size !== 'number' || !Number.isFinite(manifest.size) || manifest.size <= 0 || manifest.size > 4096))
    fail('PET_MANIFEST_INVALID: size must be a finite number greater than 0 and at most 4096')
  const configBytes = readBounded(containedPath(directory, manifest.configPath, 'configPath'), 1024 * 1024, 'PET_CONFIG_READ_FAILED')
  let config
  if (configBytes !== undefined) {
    try {
      config = parseJsonc(configBytes)
      if (!object(config))
        fail('PET_CONFIG_INVALID: config must be a JSONC object')
    }
    catch (error) {
      fail(`PET_CONFIG_INVALID: ${error.message}`)
    }
  }
  const preview = readBounded(containedPath(directory, manifest.previewPath, 'previewPath'), 8 * 1024 * 1024, 'PET_PREVIEW_READ_FAILED')
  if (preview !== undefined) {
    if (preview.length < 13 || !['GIF87a', 'GIF89a'].includes(preview.subarray(0, 6).toString('ascii'))) {
      fail('PET_PREVIEW_INVALID: preview must have a GIF87a or GIF89a header')
    }
    else {
      const width = preview.readUInt16LE(6)
      const height = preview.readUInt16LE(8)
      if (width === 0 || width > 4096 || width !== height)
        fail('PET_PREVIEW_INVALID: GIF must be square with dimensions 1..4096')
      else
        notes.push(`GIF preview ${width}x${height} (header only)`)
    }
  }
  const videoRoot = containedPath(directory, manifest.uriPath, 'uriPath', true)
  const macRoot = manifest.macUriPath === undefined ? undefined : containedPath(directory, manifest.macUriPath, 'macUriPath', true)
  if (manifest.macUriPath !== undefined && manifest.ext?.mac !== 'mov')
    fail('PET_MANIFEST_INVALID: macUriPath requires ext.mac mov')
  if (manifest.ext?.mac === 'mov' && manifest.macUriPath === undefined)
    fail('PET_MANIFEST_INVALID: ext.mac mov requires macUriPath')
  if (object(config)) {
    const names = animationNames(config)
    for (const name of names) {
      if (videoRoot !== undefined)
        readBounded(containedPath(directory, `${manifest.uriPath}/${name}.webm`, `video ${name}`), 512 * 1024 * 1024, 'PET_VIDEO_READ_FAILED', false)
      if (macRoot !== undefined)
        readBounded(containedPath(directory, `${manifest.macUriPath}/${name}.mov`, `mac video ${name}`), 512 * 1024 * 1024, 'PET_VIDEO_READ_FAILED', false)
    }
    notes.push(`video configuration references ${names.size} animation(s)`)
  }
  if (manifest.macUriPath === undefined)
    notes.push('macOS unsupported by this package: macUriPath is absent')
  notes.push('static package checks only; video decoding, alpha and macOS playback are NOT verified')
}

function grid(declared, width, height) {
  if (width % COLUMNS !== 0) {
    fail(`PET_ASSET_DIMENSIONS_INVALID: spritesheet width must be divisible by ${COLUMNS} columns`)
    return undefined
  }
  const v1 = height % V1_ROWS === 0
  const v2 = height % V2_ROWS === 0
  let version
  if (!v1 && !v2) {
    fail(`PET_ASSET_DIMENSIONS_INVALID: spritesheet height must be divisible by ${V1_ROWS} (v1) or ${V2_ROWS} (v2) rows`)
    return undefined
  }
  else if (v1 && !v2) {
    version = 1
  }
  else if (!v1 && v2) {
    version = 2
  }
  else {
    version = declared ?? 2
  }
  if (declared !== undefined && declared !== version) {
    notes.push(`pet.json declares spriteVersionNumber ${declared} but the atlas resolves to v${version}; the host trusts the atlas and derives v${version}`)
  }
  return { version, columns: COLUMNS, rows: version === 1 ? V1_ROWS : V2_ROWS }
}

function dimensions(bytes, declared) {
  let mime
  let width
  let height
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') {
      fail('PET_ASSET_FORMAT_INVALID: PNG is missing IHDR')
      return undefined
    }
    mime = 'image/png'
    width = bytes.readUInt32BE(16)
    height = bytes.readUInt32BE(20)
  }
  else if (bytes.length >= 30 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = bytes.subarray(12, 16).toString('latin1')
    if (chunk === 'VP8X' && bytes.length >= 30) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16)
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
    }
    else if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2F) {
      width = 1 + bytes[21] + ((bytes[22] & 0x3F) << 8)
      height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0F) << 10)
    }
    else if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9D && bytes[24] === 0x01 && bytes[25] === 0x2A) {
      width = bytes.readUInt16LE(26) & 0x3FFF
      height = bytes.readUInt16LE(28) & 0x3FFF
    }
    else {
      fail('PET_ASSET_FORMAT_INVALID: unsupported or malformed WebP header')
      return undefined
    }
    mime = 'image/webp'
  }
  else {
    fail('PET_ASSET_FORMAT_INVALID: spritesheet must be PNG or WebP')
    return undefined
  }
  if (width === 0 || height === 0 || width > SPRITESHEET_MAX_DIMENSION || height > SPRITESHEET_MAX_DIMENSION || width * height > SPRITESHEET_MAX_PIXELS) {
    fail(`PET_ASSET_DIMENSIONS_INVALID: spritesheet dimensions exceed ${SPRITESHEET_MAX_DIMENSION}px or ${SPRITESHEET_MAX_PIXELS} pixels`)
    return undefined
  }
  const resolved = grid(declared, width, height)
  return resolved === undefined ? undefined : { mime, width, height, grid: resolved }
}

function main() {
  const target = process.argv[2]
  if (target === undefined || target.length === 0) {
    console.error('usage: node validate-pet.mjs <pet directory>')
    process.exitCode = 2
    return
  }
  const directory = resolve(target)
  let stats
  try {
    stats = statSync(directory)
  }
  catch (error) {
    console.error(`PET_DIRECTORY_MISSING: ${directory}: ${error.message}`)
    process.exitCode = 1
    return
  }
  if (!stats.isDirectory()) {
    console.error(`PET_DIRECTORY_MISSING: ${directory} is not a directory`)
    process.exitCode = 1
    return
  }
  if (basename(resolve(directory, '..')) !== 'pets') {
    notes.push(`${directory} is not a direct child of a "pets" directory; the host enumerates only <DSH_HOME>/pets/*`)
  }

  const manifestBytes = readBounded(containedPath(directory, 'pet.json', 'pet.json'), MANIFEST_MAX_BYTES, 'PET_MANIFEST_READ_FAILED')
  if (manifestBytes === undefined) {
    report()
    return
  }
  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  }
  catch (error) {
    fail(`PET_MANIFEST_INVALID: invalid pet.json: ${error.message}`)
    report()
    return
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('PET_MANIFEST_INVALID: pet.json must be a JSON object')
    report()
    return
  }

  checkId(manifest.id)
  for (const field of ['displayName', 'description', 'kind']) {
    if (manifest[field] !== undefined && manifest[field] !== null && typeof manifest[field] !== 'string')
      fail(`PET_MANIFEST_INVALID: ${field} must be a string`)
  }
  if (manifest.kind === 'dsh') {
    notes.push(`id resolves to chat:${manifest.id}`)
    validateVideo(directory, manifest)
    report()
    return
  }

  let declared
  if (manifest.spriteVersionNumber !== undefined && manifest.spriteVersionNumber !== null) {
    declared = manifest.spriteVersionNumber
    if (declared !== 1 && declared !== 2) {
      fail('PET_SPRITE_VERSION_UNSUPPORTED: spriteVersionNumber must be 1 or 2')
      declared = undefined
    }
  }

  if (manifest.spritesheetPath === undefined) {
    fail('PET_MANIFEST_INVALID: pet.json is missing spritesheetPath')
    report()
    return
  }
  const assetPath = containedPath(directory, manifest.spritesheetPath, 'spritesheetPath')
  const assetBytes = readBounded(assetPath, SPRITESHEET_MAX_BYTES, 'PET_ASSET_READ_FAILED')
  if (assetBytes === undefined) {
    report()
    return
  }

  const resolved = dimensions(assetBytes, declared)
  notes.push(`id resolves to chat:${manifest.id}`)
  if (resolved !== undefined) {
    notes.push(`atlas ${resolved.mime} ${resolved.width}x${resolved.height} -> v${resolved.grid.version} ${resolved.grid.columns}x${resolved.grid.rows} (${resolved.width / resolved.grid.columns}x${resolved.height / resolved.grid.rows} per cell)`)
    notes.push(`expected atlas size for v${resolved.grid.version}: ${resolved.grid.columns * 192}x${resolved.grid.rows * 208}`)
  }
  report()
}

function report() {
  for (const note of notes) {
    console.log(`note: ${note}`)
  }
  if (problems.length === 0) {
    console.log('ok: static pet package validation passed (media decoding and alpha not verified)')
    process.exitCode = 0
    return
  }
  for (const problem of problems) {
    console.error(problem)
  }
  console.error(`failed: ${problems.length} contract violation(s)`)
  process.exitCode = 1
}

main()
