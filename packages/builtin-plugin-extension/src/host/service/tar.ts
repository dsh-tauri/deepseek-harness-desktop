import type { Buffer } from 'node:buffer'
import type { ExtractOptions, TarHeader } from './tar.types'
import { mkdirSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { defineService } from 'dsh-tauri'
import { dirname, join } from 'pathe'

const TAR_LIMITS = {
  entryBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  entries: 20_000,
} as const

export const tar = defineService({
  save(archive: Buffer, target: string, options: ExtractOptions = {}): number {
    const bytes = gunzipSync(archive)
    const strip = options.stripComponents ?? 0
    let offset = 0
    let written = 0
    let total = 0
    let pendingLongName: string | undefined
    let pendingPath: string | undefined
    while (offset + 512 <= bytes.length) {
      const header = readHeader(bytes.subarray(offset, offset + 512))
      if (header === null)
        break
      offset += 512
      const contentEnd = offset + header.size
      if (contentEnd > bytes.length)
        throw new Error('truncated tar entry')
      const content = bytes.subarray(offset, contentEnd)
      offset += Math.ceil(header.size / 512) * 512
      if (header.size > TAR_LIMITS.entryBytes)
        throw new Error('tar entry too large')
      total += header.size
      if (total > TAR_LIMITS.totalBytes)
        throw new Error('tar archive too large')
      if (++written > TAR_LIMITS.entries)
        throw new Error('too many tar entries')

      if (header.type === 'L') {
        pendingLongName = field(content, 0, content.length)
        continue
      }
      if (header.type === 'x' || header.type === 'X') {
        pendingPath = paxRecords(content).get('path')
        continue
      }
      if (header.type === 'g')
        continue

      let name = pendingLongName ?? pendingPath ?? header.name
      pendingLongName = undefined
      pendingPath = undefined

      const parts = name.split('/')
      if (parts.length <= strip)
        continue
      name = parts.slice(strip).join('/')
      if (name === '' || name === '/')
        continue

      const isDir = header.type === '5' || ((header.type === '0' || header.type === '\0') && name.endsWith('/'))
      if (header.type !== '0' && header.type !== '\0' && header.type !== '5')
        continue

      const resolved = safeJoin(target, name)
      if (resolved === null)
        throw new Error(`unsafe tar entry name: ${name}`)
      if (isDir) {
        mkdirSync(resolved, { recursive: true })
        continue
      }
      mkdirSync(dirname(resolved), { recursive: true })
      writeFileSync(resolved, content)
    }
    return written
  },
})

function octal(block: Buffer, offset: number, length: number): number {
  const raw = block.toString('utf8', offset, offset + length).replace(/[\0 ]+$/, '')
  return raw === '' ? 0 : Number.parseInt(raw, 8)
}

function field(block: Buffer, offset: number, length: number): string {
  const at = block.indexOf(0, offset)
  return block.toString('utf8', offset, Math.min(at === -1 ? offset + length : at, offset + length))
}

function readHeader(block: Buffer): TarHeader | null {
  if (block.every(byte => byte === 0))
    return null
  const checksum = octal(block, 148, 8)
  let sum = 0
  for (let at = 0; at < 512; at++)
    sum += at >= 148 && at < 156 ? 32 : block[at]
  if (sum !== checksum)
    return null
  const magic = block.toString('utf8', 257, 257 + 6)
  let name = field(block, 0, 100)
  if (magic.startsWith('ustar')) {
    const prefix = field(block, 345, 155)
    if (prefix !== '')
      name = `${prefix}/${name}`
  }
  return { name, size: octal(block, 124, 12), type: block.toString('utf8', 156, 157) }
}

function safeJoin(target: string, name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Z]:/i.test(normalized))
    return null
  const parts: string[] = []
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.')
      continue
    if (part === '..')
      return null
    parts.push(part)
  }
  if (parts.length === 0)
    return null
  return join(target, ...parts)
}

function paxRecords(content: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  let cursor = 0
  while (cursor < content.length) {
    const spaceAt = content.indexOf(' ', cursor)
    if (spaceAt === -1)
      break
    const length = Number.parseInt(content.toString('utf8', cursor, spaceAt), 10)
    if (!Number.isInteger(length) || length <= 0 || cursor + length > content.length)
      break
    const record = content.toString('utf8', spaceAt + 1, cursor + length).trimEnd()
    const eq = record.indexOf('=')
    if (eq > 0)
      out.set(record.slice(0, eq), record.slice(eq + 1))
    cursor += length
  }
  return out
}
