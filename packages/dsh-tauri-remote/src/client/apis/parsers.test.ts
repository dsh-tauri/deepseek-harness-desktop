import type { MachineRow, MachineStatus } from '../types/index'
import { describe, expect, it } from 'vitest'
import {
  enabledOf,
  errorMessageOf,
  installResultOf,
  isTransportError,
  machineEventsOf,
  machineListOf,
  savePayloadOf,
  sessionRoleOf,
  settingsWarningOf,
  syncApplyResultOf,
  syncPreviewOf,
  testResultOf,
  tunnelUrlOf,
} from './parsers'

const machineA: MachineRow = {
  id: 'a',
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  hasPassword: true,
  hasPassphrase: false,
  remotePort: 3080,
}
const machineB: MachineRow = {
  ...machineA,
  id: 'b',
  name: 'beta',
  host: '10.0.0.2',
  port: 2222,
  user: 'deploy',
  hasPassword: false,
  hasPassphrase: true,
  remotePort: 3000,
  startCommand: 'dsh web --host 127.0.0.1 --port 3000',
}

function rowOf(value: unknown): MachineRow | undefined {
  return machineListOf({ items: [value] }).machines[0]
}

function stateOf(value: unknown): MachineStatus['state'] | undefined {
  return machineListOf({ items: [{ id: 'a', state: value }] }).statuses.a?.state
}

describe('machine rows', () => {
  it('parses a well-formed redacted row', () => {
    expect(rowOf(machineA)).toEqual(machineA)
    expect(rowOf(machineB)).toEqual(machineB)
  })

  it('rejects malformed rows', () => {
    expect(rowOf(undefined)).toBeUndefined()
    expect(rowOf('x')).toBeUndefined()
    expect(rowOf({ ...machineA, id: '' })).toBeUndefined()
    expect(rowOf({ ...machineA, id: 5 })).toBeUndefined()
    expect(rowOf({ ...machineA, name: 5 })).toBeUndefined()
    expect(rowOf({ ...machineA, host: '' })).toBeUndefined()
    expect(rowOf({ ...machineA, user: 5 })).toBeUndefined()
  })

  it('falls back to defaults for absent numeric fields and optional startCommand', () => {
    const row = rowOf({ ...machineA, port: undefined, remotePort: undefined, startCommand: '', hasPassword: undefined })
    expect(row).toMatchObject({ port: 22, remotePort: 3080, hasPassword: false })
    expect(row).not.toHaveProperty('startCommand')
  })

  it('accepts an empty user (resolved from ~/.ssh config or the OS user)', () => {
    const row = rowOf({ ...machineA, user: '' })
    expect(row).toMatchObject({ user: '' })
  })

  it('keeps only a well-formed profile name and a true tint flag', () => {
    expect(rowOf({ ...machineA, profileName: ' dev-box ', color: '', tintBorder: false }))
      .toEqual({ ...machineA, profileName: 'dev-box' })
    expect(rowOf({ ...machineA, profileName: 'bad name' })).not.toHaveProperty('profileName')
    expect(rowOf({ ...machineA, profileName: 7 })).not.toHaveProperty('profileName')
    expect(rowOf({ ...machineA, color: '#ff0000', tintBorder: true }))
      .toMatchObject({ color: '#ff0000', tintBorder: true })
  })
})

describe('savePayloadOf', () => {
  it('builds the config row and carries only typed secrets', () => {
    expect(savePayloadOf(machineB, { passphrase: 'PHRASE', password: '' })).toEqual({
      machineId: 'b',
      row: {
        name: 'beta',
        host: '10.0.0.2',
        port: 2222,
        user: 'deploy',
        remotePort: 3000,
        startCommand: 'dsh web --host 127.0.0.1 --port 3000',
      },
      secrets: { passphrase: 'PHRASE' },
    })
    expect(savePayloadOf(machineA, {})).toEqual({
      machineId: 'a',
      row: { name: 'alpha', host: '10.0.0.1', port: 22, user: 'root', remotePort: 3080 },
    })
    expect(savePayloadOf({ ...machineA, startCommand: '' }, {})).not.toHaveProperty('row.startCommand')
  })
})

describe('machineEventsOf', () => {
  it('parses well-formed events and drops malformed ones', () => {
    expect(machineEventsOf({ items: [
      { seq: 2, ts: '2025-09-01T00:00:01.000Z', machineId: 'a', stage: 'probe', line: 'probing' },
      { seq: 3, ts: '2025-09-01T00:00:02.000Z', machineId: 'a', stage: 'install', line: 'pnpm install', terminal: 'success' },
      { seq: 4, ts: '2025-09-01T00:00:03.000Z', machineId: 'a', stage: 'auth', line: 'gave up', terminal: 'failed', reason: 'auth failed' },
    ] })).toEqual([
      { seq: 2, ts: '2025-09-01T00:00:01.000Z', machineId: 'a', stage: 'probe', line: 'probing' },
      { seq: 3, ts: '2025-09-01T00:00:02.000Z', machineId: 'a', stage: 'install', line: 'pnpm install', terminal: 'success' },
      { seq: 4, ts: '2025-09-01T00:00:03.000Z', machineId: 'a', stage: 'auth', line: 'gave up', terminal: 'failed', reason: 'auth failed' },
    ])
    expect(machineEventsOf(undefined)).toEqual([])
    expect(machineEventsOf({ items: 'nope' })).toEqual([])
    expect(machineEventsOf({ items: [{ machineId: 'a', line: 'x' }, 'junk'] })).toEqual([])
    expect(machineEventsOf({ items: [{ seq: 1, ts: 1_700_000_000, machineId: 'a', line: 'x' }] })).toEqual([])
    expect(machineEventsOf({ items: [{ seq: 1, ts: '2025-09-01T00:00:00.000Z', machineId: 'a', line: 'x', terminal: true }] })[0]).not.toHaveProperty('terminal')
  })
})

describe('machineListOf', () => {
  it('tolerates a list response without the items key', () => {
    expect(machineListOf({})).toEqual({ machines: [], discovered: [], statuses: {} })
    expect(machineListOf(undefined)).toEqual({ machines: [], discovered: [], statuses: {} })
  })

  it('parses the manual machines, the discovered aliases, and their live statuses', () => {
    const snapshot = machineListOf({
      items: [
        { ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' },
        { ...machineB, state: 'disconnected', lastError: 'auth failed' },
        { ...machineA, id: 'c', name: 'gamma', state: 'disconnected' },
      ],
      discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: 'root', hasPassword: false, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:9' }],
    })
    expect(snapshot.machines.map(row => row.id)).toEqual(['a', 'b', 'c'])
    expect(snapshot.discovered.map(row => row.id)).toEqual(['dev'])
    expect(snapshot.discovered[0]).toMatchObject({ host: 'dev', user: 'root', hasPassword: false, hasPassphrase: false })
    expect(snapshot.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' })
    expect(snapshot.statuses.b).toEqual({ state: 'disconnected', lastError: 'auth failed' })
    expect(snapshot.statuses.c).toEqual({ state: 'disconnected' })
    expect(snapshot.statuses.dev).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:9' })
  })

  it('reads the C-STATE states, the retry instant, the auth method, the progress, and dshMissing', () => {
    const snapshot = machineListOf({
      items: [
        { ...machineA, state: 'reconnecting', nextRetryAt: 1_700_000_008_000, authMethod: 'key' },
        { ...machineA, id: 'b', state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } },
        { ...machineA, id: 'c', state: 'disconnected', lastError: 'dsh is not installed', dshMissing: true },
      ],
    })
    expect(snapshot.statuses.a).toMatchObject({ state: 'reconnecting', nextRetryAt: 1_700_000_008_000, authMethod: 'key' })
    expect(snapshot.statuses.b).toEqual({ state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } })
    expect(snapshot.statuses.c).toMatchObject({ dshMissing: true, lastError: 'dsh is not installed' })
  })

  it('drops status entries without an id and reads unknown states as disconnected', () => {
    const snapshot = machineListOf({ items: [{ ...machineA, id: '', state: 'connected' }, { ...machineA, id: 'a', state: 'warping' }] })
    expect(snapshot.machines.map(row => row.id)).toEqual(['a'])
    expect(snapshot.statuses.a?.state).toBe('disconnected')
  })
})

describe('machine lifecycle states', () => {
  it('reads the six C-STATE values and nothing else', () => {
    for (const state of ['disconnected', 'testing', 'connecting', 'connected', 'reconnecting', 'given-up'])
      expect(stateOf(state)).toBe(state)
    expect(stateOf('warping')).toBe('disconnected')
    expect(stateOf(undefined)).toBe('disconnected')
  })
})

describe('syncPreviewOf', () => {
  it('parses the previewed plugins and skills', () => {
    expect(syncPreviewOf({
      plugins: [{ name: 'p', spec: 'github:a/b', syncable: true }],
      skills: [{ name: 's', root: 'dsh' }],
    })).toEqual({
      plugins: [{ name: 'p', spec: 'github:a/b', syncable: true }],
      skills: [{ name: 's', root: 'dsh' }],
    })
  })

  it('keeps the unsyncable reason and drops malformed entries', () => {
    expect(syncPreviewOf({
      plugins: [{ name: 'p', spec: 'github:a/b', syncable: false, reason: 'local dev link' }, { name: 'x' }, 'junk'],
      skills: [{ name: 's', root: 'dsh' }, { root: 'dsh' }],
    })).toEqual({
      plugins: [{ name: 'p', spec: 'github:a/b', syncable: false, reason: 'local dev link' }],
      skills: [{ name: 's', root: 'dsh' }],
    })
  })

  it('reads a wrong shape as null', () => {
    expect(syncPreviewOf(undefined)).toBeNull()
    expect(syncPreviewOf({ plugins: [] })).toBeNull()
    expect(syncPreviewOf({ plugins: 'nope', skills: [] })).toBeNull()
  })
})

describe('syncApplyResultOf', () => {
  it('parses the per-item results and drops malformed entries', () => {
    expect(syncApplyResultOf({ items: [
      { kind: 'plugin', name: 'p', ok: true },
      { kind: 'skill', name: 's', root: 'dsh', ok: false, error: 'exit 1', log: 'boom' },
      { kind: 'nope', name: 'x', ok: true },
      { kind: 'plugin', name: 'y' },
      'junk',
    ] })).toEqual({ items: [
      { kind: 'plugin', name: 'p', ok: true },
      { kind: 'skill', name: 's', root: 'dsh', ok: false, error: 'exit 1', log: 'boom' },
    ] })
  })

  it('reads a wrong shape as null', () => {
    expect(syncApplyResultOf(undefined)).toBeNull()
    expect(syncApplyResultOf({})).toBeNull()
    expect(syncApplyResultOf({ items: 'nope' })).toBeNull()
  })
})

describe('enabledOf', () => {
  it('reads a boolean switch and nothing else', () => {
    expect(enabledOf({ enabled: true })).toBe(true)
    expect(enabledOf({ enabled: false })).toBe(false)
    expect(enabledOf({})).toBeUndefined()
    expect(enabledOf({ enabled: 'yes' })).toBeUndefined()
    expect(enabledOf(undefined)).toBeUndefined()
  })
})

describe('settingsWarningOf', () => {
  it('reads the migration warning and treats a missing or blank one as absent', () => {
    expect(settingsWarningOf({ enabled: true, warning: 'machines.json 不是合法 JSON' })).toBe('machines.json 不是合法 JSON')
    expect(settingsWarningOf({ enabled: true })).toBeNull()
    expect(settingsWarningOf({ enabled: true, warning: '' })).toBeNull()
    expect(settingsWarningOf({ enabled: true, warning: 7 })).toBeNull()
    expect(settingsWarningOf(undefined)).toBeNull()
  })
})

describe('sessionRoleOf', () => {
  it('reads the remote flag and the originating host', () => {
    expect(sessionRoleOf({ role: 'remote', remote: true, origin: 'ops' })).toEqual({ remote: true, origin: 'ops' })
    expect(sessionRoleOf({ role: 'local', remote: false })).toEqual({ remote: false })
    expect(sessionRoleOf(undefined)).toEqual({ remote: false })
    expect(sessionRoleOf({ remote: 'yes', origin: '' })).toEqual({ remote: false })
  })
})

describe('testResultOf', () => {
  it('reads the probe verdict and its prose', () => {
    expect(testResultOf({ ok: true, banner: 'Linux alpha' })).toEqual({ ok: true, banner: 'Linux alpha' })
    expect(testResultOf({ ok: false, message: 'auth failed' })).toEqual({ ok: false, message: 'auth failed' })
    expect(testResultOf({ ok: true })).toEqual({ ok: true })
    expect(testResultOf(undefined)).toEqual({ ok: false })
  })
})

describe('tunnelUrlOf', () => {
  it('reads the tunnel url or nothing at all', () => {
    expect(tunnelUrlOf({ tunnelBaseUrl: 'http://127.0.0.1:1' })).toBe('http://127.0.0.1:1')
    expect(tunnelUrlOf({})).toBe('')
    expect(tunnelUrlOf(undefined)).toBe('')
  })
})

describe('installResultOf', () => {
  it('reads the install outcome and its optional credential error', () => {
    expect(installResultOf({ dshPath: '/bin/dsh', credentialsCopied: true }))
      .toEqual({ dshPath: '/bin/dsh', credentialsCopied: true })
    expect(installResultOf({ credentialsCopied: false, credentialsError: 'disk full' }))
      .toEqual({ dshPath: '', credentialsCopied: false, credentialsError: 'disk full' })
    expect(installResultOf(undefined)).toEqual({ dshPath: '', credentialsCopied: false })
  })
})

describe('errorMessageOf', () => {
  it('maps the missing-endpoint statuses to the stable transport code', () => {
    expect(errorMessageOf(new Error('请求失败 (405)'))).toBe('REMOTE_API_HTTP_405')
    expect(errorMessageOf(new Error('请求失败 (404)'))).toBe('REMOTE_API_HTTP_404')
  })

  it('keeps the host prose and the unknown transport failures', () => {
    expect(errorMessageOf(new Error('请求失败 (400): refused'))).toBe('refused')
    expect(errorMessageOf(new Error('请求失败 (500): boom'))).toBe('boom')
    expect(errorMessageOf(new Error('请求失败 (500)'))).toBe('请求失败 (500)')
    expect(errorMessageOf(new Error('auth failed'))).toBe('auth failed')
    expect(errorMessageOf('thrown prose')).toBe('thrown prose')
  })
})

describe('isTransportError', () => {
  it('separates the transport codes from host-provided prose', () => {
    expect(isTransportError('REMOTE_API_HTTP_405')).toBe(true)
    expect(isTransportError('REMOTE_API_EMPTY')).toBe(true)
    expect(isTransportError('auth failed')).toBe(false)
  })
})
