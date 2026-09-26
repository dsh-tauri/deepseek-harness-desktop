/**
 * Trust-on-first-use host-key store for SSH connections. One JSON document
 * under the harness home records the accepted host-key fingerprint per
 * machine profile; a connection whose fingerprint matches is accepted, an
 * unknown one is accepted-and-persisted (TOFU), and a mismatch is rejected so
 * a swapped host cannot impersonate a known machine without an operator
 * resetting the record. Self-contained: the atomic write is a same-directory
 * temp + rename (no harness dependencies).
 * @module dsh-tauri-ssh/host/service/host-keys
 */

import type { Buffer } from 'node:buffer'
import type { MachineId } from '../types/index'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'pathe'

/** One persisted host-key record. */
export interface HostKeyRecord {
  /** Machine profile id the record belongs to. */
  machineId: string
  /** Fingerprint the profile's first successful connection saw. */
  fingerprint: string
}

/** Verdict of one host-key check. */
export type HostKeyVerdict = 'accepted' | 'unknown' | 'mismatch'

/** Fingerprint a raw SSH host key into the ssh-keygen-style `SHA256:<base64>` form. */
export function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

/** Atomically replace `filename` with `content` (owner-only permissions, same-dir rename). */
async function writeFileAtomic(filename: string, content: string): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' })
    await rename(temp, filename)
  }
  catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * File-backed TOFU store. Reads are cached in memory and refreshed on each
 * load; writes are atomic.
 */
export class KnownHostsStore {
  private records: HostKeyRecord[] = []

  /**
   * @param file - absolute path of the known-hosts JSON document.
   */
  constructor(private readonly file: string) {}

  /**
   * Load the document (idempotent, cached). A missing or malformed document
   * starts empty — the store must never block a first connection on its own
   * durability.
   */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = []
        return
      }
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      this.records = Array.isArray(parsed) ? parsed as HostKeyRecord[] : []
    }
    catch {
      // A corrupt document resets trust rather than failing every connection.
      this.records = []
    }
  }

  /**
   * Check one machine's fingerprint against the store.
   * @param machineId - the machine profile being connected.
   * @param fingerprint - the presented host-key fingerprint.
   * @returns `accepted` on a match, `unknown` on a first sight, `mismatch` on a conflict.
   */
  async verify(machineId: MachineId, fingerprint: string): Promise<HostKeyVerdict> {
    await this.load()
    const record = this.records.find(entry => entry.machineId === machineId)
    if (record === undefined)
      return 'unknown'
    return record.fingerprint === fingerprint ? 'accepted' : 'mismatch'
  }

  /**
   * Persist a first-sight fingerprint (the TOFU commit). A concurrent
   * mismatch never overwrites: the caller verifies first.
   * @param machineId - the machine profile being connected.
   * @param fingerprint - the fingerprint to remember.
   */
  async accept(machineId: MachineId, fingerprint: string): Promise<void> {
    await this.load()
    const others = this.records.filter(entry => entry.machineId !== machineId)
    this.records = [...others, { machineId, fingerprint }]
    await writeFileAtomic(this.file, JSON.stringify(this.records, null, 2))
  }

  /**
   * Forget one machine's record (the operator-side reset when a host key
   * legitimately changed). Idempotent.
   * @param machineId - the machine whose record to drop.
   */
  async forget(machineId: MachineId): Promise<void> {
    const next = this.records.filter(entry => entry.machineId !== machineId)
    if (next.length === this.records.length)
      return
    this.records = next
    await writeFileAtomic(this.file, JSON.stringify(this.records, null, 2))
  }
}
