import type { MachineProfile } from '../types/index'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MachineId } from '../types/index'

const mocks = vi.hoisted(() => ({
  machineProfiles: new Map<string, MachineProfile>(),
  machineStates: new Map<string, { generation: number, phase: string, switchOwner?: { machineId: string, generation: number } }>(),
  emitStatus: vi.fn(),
  transportConnect: vi.fn(),
}))

vi.mock('../config/runtime', () => ({
  harnessHome: () => '/tmp/dsh',
  homeDirPath: () => '/home/tester',
  eventBuffers: new Map(),
  eventRingCapacity: () => 200,
  hostConfig: () => ({ reconnectMaxAttempts: 0, reconnectInitialDelayMs: 1000, reconnectMaxDelayMs: 30_000 }),
  machineProfiles: mocks.machineProfiles,
  machineRuntimeDeps: () => ({
    transport: {
      resolve: () => ({
        capabilities: { exec: true, stream: true },
        connect: mocks.transportConnect,
      }),
    },
    emitStatus: mocks.emitStatus,
    localAllowlist: () => ({ allow: [] }),
  }),
  machineStates: mocks.machineStates,
  machineTable: { enabled: true, machines: new Map() },
  sshDirPath: () => '/tmp/ssh',
}))

const machineId = MachineId('build')

function profileOf(): MachineProfile {
  return {
    id: machineId,
    name: 'build',
    host: '127.0.0.1',
    port: 22,
    user: 'tester',
    remotePort: 4001,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.machineProfiles.clear()
  mocks.machineStates.clear()
  mocks.machineProfiles.set(machineId, profileOf())
  mocks.transportConnect.mockRejectedValue(new Error('transport down'))
})

describe('切换独占机器', () => {
  it('切换期间拒绝普通连接、安装和第二次切换', async () => {
    const { machine } = await import('./machine')
    const lease = await machine.beginSwitch(machineId)

    await expect(machine.connect(machineId)).rejects.toThrow(/switching the core/)
    await expect(machine.install(machineId)).rejects.toThrow(/switching the core/)
    await expect(machine.beginSwitch(machineId)).rejects.toThrow(/already switching the core/)

    expect(machine.switchLeaseValid(lease)).toBe(true)
    expect(mocks.transportConnect).not.toHaveBeenCalled()
  })

  it('切换结束后把机器交还给普通连接', async () => {
    const { machine } = await import('./machine')
    const lease = await machine.beginSwitch(machineId)
    machine.endSwitch(lease)

    expect(machine.switchLeaseValid(lease)).toBe(false)
    await expect(machine.connect(machineId)).rejects.toThrow(/transport down/)
    expect(mocks.transportConnect).toHaveBeenCalled()
  })

  it('租约失效后重建连接会被拒绝', async () => {
    const { machine } = await import('./machine')
    const lease = await machine.beginSwitch(machineId)
    await machine.disconnect(machineId)

    expect(machine.switchLeaseValid(lease)).toBe(false)
    await expect(machine.reconnect(machineId, { profileSync: false })).rejects.toThrow(/switching the core/)
    await expect(machine.reconnect(machineId, { profileSync: false, lease })).rejects.toThrow(/transport down/)
  })
})
