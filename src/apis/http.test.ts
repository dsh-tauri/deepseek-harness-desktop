import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMachines, getMachinesEvents, postMachinesConnect } from './remote'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

beforeEach(() => invoke.mockReset())
afterEach(() => vi.restoreAllMocks())

describe('generated remote API transport', () => {
  it('列表和事件参数通过 remote invoke 转发，不在前端拼服务地址', async () => {
    invoke.mockResolvedValueOnce({ enabled: true, items: [] }).mockResolvedValueOnce({ items: [] })
    await expect(getMachines()).resolves.toEqual({ enabled: true, items: [] })
    await expect(getMachinesEvents({ machineId: 'm1', sinceSeq: 3 })).resolves.toEqual({ items: [] })
    expect(invoke.mock.calls).toEqual([
      ['remote', { method: 'GET /api/tauri/ssh/machines', payload: null }],
      ['remote', { method: 'GET /api/tauri/ssh/machines/events', payload: { machineId: 'm1', sinceSeq: 3 } }],
    ])
  })

  it('连接载荷原样传递并保留 Rust 拒绝码', async () => {
    invoke.mockRejectedValueOnce('REMOTE_API_MISSING: 405')
    await expect(postMachinesConnect({ machineId: 'm1' })).rejects.toBe('REMOTE_API_MISSING: 405')
    expect(invoke).toHaveBeenCalledWith('remote', {
      method: 'POST /api/tauri/ssh/machines/connect',
      payload: { machineId: 'm1' },
    })
  })
})
