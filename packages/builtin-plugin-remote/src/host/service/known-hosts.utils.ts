import type { Buffer } from 'node:buffer'
import type { HostKeyRecord } from './known-hosts.types'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'pathe'

export function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

export async function readHostKeyRecords(file: string): Promise<HostKeyRecord[]> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return []
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as HostKeyRecord[] : []
  }
  catch {
    return []
  }
}

export async function writeHostKeyRecords(file: string, records: HostKeyRecord[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, JSON.stringify(records, null, 2), { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  }
  catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
