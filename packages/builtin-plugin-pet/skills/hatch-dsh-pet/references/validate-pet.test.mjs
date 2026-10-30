import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'

const validator = fileURLToPath(new URL('./validate-pet.mjs', import.meta.url))
let root
let manifest
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-pet-validator-'))
  mkdirSync(join(root, 'webm'))
  mkdirSync(join(root, 'preview'))
  manifest = { kind: 'dsh', id: 'fixture', configPath: 'config.jsonc', uriPath: 'webm', previewPath: 'preview/preview.gif', ext: { default: 'webm', mac: 'webm' } }
  writeFileSync(join(root, 'config.jsonc'), '{ /* config */ "motions": { "idle": "idle", }, }')
  writeFileSync(join(root, 'webm/idle.webm'), 'static existence fixture, not decoded media')
  writeFileSync(join(root, 'preview/preview.gif'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function validate() {
  writeFileSync(join(root, 'pet.json'), JSON.stringify(manifest))
  return spawnSync(process.execPath, [validator, root], { encoding: 'utf8', timeout: 5000 })
}

function webpAtlas(width = 88, height = 88) {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(22, 4)
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8X', 12, 'ascii')
  bytes.writeUInt32LE(10, 16)
  bytes.writeUIntLE(width - 1, 24, 3)
  bytes.writeUIntLE(height - 1, 27, 3)
  return bytes
}

it('accepts a local WebM package with JSONC and a square GIF without claiming decoded playback', () => {
  const result = validate()
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('video configuration references 1 animation(s)')
  expect(result.stdout).toContain('video decoding, alpha and macOS playback are NOT verified')
})

it('rejects a MOV platform extension without a mac video directory', () => {
  manifest.ext.mac = 'mov'
  const result = validate()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('PET_MANIFEST_INVALID: ext.mac mov requires macUriPath')
})

it('rejects missing referenced video files', () => {
  writeFileSync(join(root, 'config.jsonc'), '{"motions":{"idle":"missing"}}')
  const result = validate()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('PET_ASSET_READ_FAILED: video missing')
})

it('accepts a Codex atlas manifest whose kind uses a foreign vocabulary', () => {
  // 外部生态用 kind 标注宠物类别（如 person/pet），图集导入只看 spritesheetPath，
  // 白名单会把这类宠物误判为非法清单。
  manifest = { kind: 'person', id: 'fixture', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp' }
  writeFileSync(join(root, 'spritesheet.webp'), webpAtlas())
  const result = validate()
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('atlas image/webp 88x88 -> v2 8x11')
})

it.each([{ kind: false }, { kind: 1 }, { kind: {} }, { kind: [] }])('rejects a non-string kind $kind like the Rust importer', ({ kind }) => {
  manifest = { kind, id: 'fixture', spritesheetPath: 'spritesheet.webp' }
  writeFileSync(join(root, 'spritesheet.webp'), webpAtlas())
  const result = validate()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('PET_MANIFEST_INVALID: kind must be a string')
})
