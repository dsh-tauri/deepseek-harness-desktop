import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachineId } from '../types/index'
import { fingerprintHostKey, KnownHostsStore } from './host-keys'

// Wrap the real fs/promises so one test can force an atomic-rename failure;
// every other call passes through to the actual implementation.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) }
})

const roots: string[] = []

function tempFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-keys-'))
  roots.push(root)
  return join(root, name)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('fingerprintHostKey', () => {
  it('produces the ssh-keygen-style SHA256 form without padding', () => {
    const fingerprint = fingerprintHostKey(Buffer.from('host-key-bytes'))
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(fingerprint).not.toMatch(/=$/u)
    expect(fingerprintHostKey(Buffer.from('host-key-bytes'))).toBe(fingerprint)
    expect(fingerprintHostKey(Buffer.from('other'))).not.toBe(fingerprint)
  })
})

describe('knownHostsStore', () => {
  it('starts empty on a missing document', async () => {
    const store = new KnownHostsStore(tempFile('missing.json'))
    expect(await store.verify(MachineId('m1'), 'SHA256:abc')).toBe('unknown')
  })

  it('accepts and persists a first sight, then verifies it', async () => {
    const file = tempFile('hosts.json')
    const store = new KnownHostsStore(file)
    const fingerprint = 'SHA256:first'
    expect(await store.verify(MachineId('m1'), fingerprint)).toBe('unknown')
    await store.accept(MachineId('m1'), fingerprint)
    const reloaded = new KnownHostsStore(file)
    expect(await reloaded.verify(MachineId('m1'), fingerprint)).toBe('accepted')
    expect(await reloaded.verify(MachineId('m1'), 'SHA256:other')).toBe('mismatch')
    expect(await reloaded.verify(MachineId('m2'), fingerprint)).toBe('unknown')
  })

  it('keeps records of other machines on accept', async () => {
    const file = tempFile('hosts.json')
    const store = new KnownHostsStore(file)
    await store.accept(MachineId('m1'), 'SHA256:a')
    await store.accept(MachineId('m2'), 'SHA256:b')
    const reloaded = new KnownHostsStore(file)
    expect(await reloaded.verify(MachineId('m1'), 'SHA256:a')).toBe('accepted')
    expect(await reloaded.verify(MachineId('m2'), 'SHA256:b')).toBe('accepted')
  })

  it('forgets one machine idempotently', async () => {
    const file = tempFile('hosts.json')
    const store = new KnownHostsStore(file)
    await store.accept(MachineId('m1'), 'SHA256:a')
    await store.accept(MachineId('m2'), 'SHA256:b')
    await store.forget(MachineId('m1'))
    await store.forget(MachineId('m1'))
    const reloaded = new KnownHostsStore(file)
    expect(await reloaded.verify(MachineId('m1'), 'SHA256:a')).toBe('unknown')
    expect(await reloaded.verify(MachineId('m2'), 'SHA256:b')).toBe('accepted')
  })

  it('treats a corrupt document as empty and rewrites it on accept', async () => {
    const file = tempFile('hosts.json')
    const store = new KnownHostsStore(file)
    await store.accept(MachineId('m1'), 'SHA256:a')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
    raw.push({ machineId: 'broken' })
    writeFileSync(file, JSON.stringify(raw))
    await store.accept(MachineId('m2'), 'SHA256:b')
    const reloaded = new KnownHostsStore(file)
    expect(await reloaded.verify(MachineId('m1'), 'SHA256:a')).toBe('accepted')
  })

  it('treats a non-array document as empty', async () => {
    const file = tempFile('hosts.json')
    writeFileSync(file, JSON.stringify({ not: 'an array' }))
    const store = new KnownHostsStore(file)
    expect(await store.verify(MachineId('m1'), 'SHA256:a')).toBe('unknown')
  })

  it('rejects invalid JSON as empty', async () => {
    const file = tempFile('hosts.json')
    writeFileSync(file, 'not json {')
    const store = new KnownHostsStore(file)
    expect(await store.verify(MachineId('m1'), 'SHA256:a')).toBe('unknown')
    await store.accept(MachineId('m1'), 'SHA256:a')
    const reloaded = new KnownHostsStore(file)
    expect(await reloaded.verify(MachineId('m1'), 'SHA256:a')).toBe('accepted')
  })

  it('rethrows non-ENOENT read failures', async () => {
    const path = tempFile('hosts.json')
    mkdirSync(path)
    const store = new KnownHostsStore(path)
    await expect(store.verify(MachineId('m1'), 'SHA256:a')).rejects.toThrow()
  })

  it('cleans up the temp document and rethrows when the atomic rename fails', async () => {
    const file = tempFile('hosts.json')
    const store = new KnownHostsStore(file)
    vi.mocked(fsPromises.rename).mockRejectedValueOnce(new Error('rename failed'))
    await expect(store.accept(MachineId('m1'), 'SHA256:a')).rejects.toThrow('rename failed')
    expect(readdirSync(dirname(file)).filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  it('swallows a failing temp cleanup and rethrows the original failure', async () => {
    const file = tempFile('hosts.json')
    const store = new KnownHostsStore(file)
    vi.mocked(fsPromises.rename).mockRejectedValueOnce(new Error('rename failed'))
    vi.mocked(fsPromises.rm).mockRejectedValueOnce(new Error('rm failed'))
    await expect(store.accept(MachineId('m1'), 'SHA256:a')).rejects.toThrow('rename failed')
  })
})
