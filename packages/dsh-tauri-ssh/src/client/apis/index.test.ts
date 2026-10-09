// @vitest-environment node
import type { MachineRow } from '../types/index'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import * as api from './index'

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const API = '/api/tauri/ssh'

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
const saveRow = { name: 'alpha', host: '10.0.0.1', port: 22, user: 'root', remotePort: 3080 }

beforeEach(() => {
  resetWire()
})

describe('the request layer', () => {
  it('sends every request to its own REST endpoint', async () => {
    const table: { run: () => Promise<unknown>, url: string, http: string, body?: Record<string, unknown>, params?: Record<string, unknown>, value: unknown, result: unknown }[] = [
      { run: () => api.getSettings(), url: '/settings', http: 'GET', value: { enabled: true }, result: { enabled: true } },
      { run: () => api.postSettings({ enabled: false }), url: '/settings', http: 'POST', body: { enabled: false }, value: { enabled: false }, result: { enabled: false } },
      { run: () => api.getSessionRole(), url: '/session/role', http: 'GET', value: { role: 'remote', remote: true, origin: 'ops' }, result: { role: 'remote', remote: true, origin: 'ops' } },
      { run: () => api.getMachines(), url: '/machines', http: 'GET', value: { items: [machineA], discovered: [] }, result: { items: [machineA], discovered: [] } },
      { run: () => api.getMachinesEvents({ machineId: 'a' }), url: '/machines/events', http: 'GET', params: { machineId: 'a' }, value: { items: [] }, result: { items: [] } },
      { run: () => api.getMachinesEvents({ machineId: 'a', sinceSeq: 7 }), url: '/machines/events', http: 'GET', params: { machineId: 'a', sinceSeq: 7 }, value: { items: [] }, result: { items: [] } },
      { run: () => api.postMachinesTest({ machineId: 'a' }), url: '/machines/test', http: 'POST', body: { machineId: 'a' }, value: { ok: true, banner: 'Linux alpha' }, result: { ok: true, banner: 'Linux alpha' } },
      { run: () => api.postMachinesConnect({ machineId: 'a' }), url: '/machines/connect', http: 'POST', body: { machineId: 'a' }, value: { tunnelBaseUrl: 'http://127.0.0.1:1' }, result: { tunnelBaseUrl: 'http://127.0.0.1:1' } },
      { run: () => api.postMachinesDisconnect({ machineId: 'a' }), url: '/machines/disconnect', http: 'POST', body: { machineId: 'a' }, value: {}, result: {} },
      { run: () => api.postMachinesInstall({ machineId: 'a' }), url: '/machines/install', http: 'POST', body: { machineId: 'a' }, value: { dshPath: '/bin/dsh', credentialsCopied: true }, result: { dshPath: '/bin/dsh', credentialsCopied: true } },
      { run: () => api.postMachines({ machineId: 'a', row: saveRow }), url: '/machines', http: 'POST', body: { machineId: 'a', row: saveRow }, value: {}, result: {} },
      { run: () => api.deleteMachines({ machineId: 'a' }), url: '/machines', http: 'DELETE', body: { machineId: 'a' }, value: {}, result: {} },
      { run: () => api.getSyncPreview(), url: '/sync/preview', http: 'GET', value: { plugins: [], skills: [] }, result: { plugins: [], skills: [] } },
      { run: () => api.postSyncApply({ machineId: 'a', plugins: [], skills: [] }), url: '/sync/apply', http: 'POST', body: { machineId: 'a', plugins: [], skills: [] }, value: { items: [] }, result: { items: [] } },
    ]
    for (const entry of table) {
      resetWire()
      answer(() => replies.ok(entry.value))
      await expect(entry.run()).resolves.toEqual(entry.result)
      expect(sent).toEqual([{
        url: `${API}${entry.url}`,
        http: entry.http,
        body: entry.body ?? {},
        params: entry.params ?? {},
      }])
    }
  })

  it('hands the decoded body through untouched', async () => {
    answer(() => replies.ok({ items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:9' }], discovered: [] }))
    await expect(api.getMachines()).resolves.toEqual({
      items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:9' }],
      discovered: [],
    })
  })

  it('reads a malformed sync payload as null instead of throwing', async () => {
    answer(() => replies.ok({ plugins: 'nope' }))
    await expect(api.getSyncPreview()).resolves.toEqual({ plugins: 'nope' })
    resetWire()
    answer(() => replies.ok({}))
    await expect(api.postSyncApply({ machineId: 'a', plugins: [], skills: [] })).resolves.toEqual({})
  })

  it('surfaces a host-provided failure as its prose', async () => {
    answer(() => replies.fail('refused'))
    await expect(api.postMachinesConnect({ machineId: 'a' })).rejects.toThrowError('请求失败 (400): refused')
  })

  it('reports a missing endpoint with its status', async () => {
    answer(() => replies.http(405))
    await expect(api.getSettings()).rejects.toThrowError('请求失败 (405)')
  })

  it('resolves an empty body as undefined', async () => {
    answer(() => replies.empty())
    await expect(api.getSettings()).resolves.toBeUndefined()
  })
})
