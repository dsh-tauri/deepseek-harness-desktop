import type { MachineProfile } from '../types/index'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MachineId } from '../types/index'

const mocks = vi.hoisted(() => ({
  machineProfiles: new Map<string, MachineProfile>(),
  machineStates: new Map<string, {
    generation: number
    phase: string
    switchOwner?: { machineId: string, generation: number }
    session?: { close: () => Promise<void> }
    connectAttempting?: Promise<void>
  }>(),
  emitStatus: vi.fn(),
  transportConnect: vi.fn(),
}))

vi.mock('../config/runtime', () => ({
  harnessHome: () => '/tmp/dsh',
  homeDirPath: () => '/home/tester',
  eventBuffers: new Map(),
  eventRingCapacity: () => 200,
  hasCoreInstallTask: () => false,
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

  it('等待旧连接关闭期间就已经独占机器', async () => {
    const { machine } = await import('./machine')
    let release: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.machineStates.set(machineId, {
      generation: 0,
      phase: 'connected',
      session: { close: () => closed },
    })

    const pending = machine.beginSwitch(machineId)
    // 等待资源关闭的这段时间里，连接和另一次切换都要让开：
    // 否则它们可能在目录互换前连回旧核心。
    await expect(machine.connect(machineId)).rejects.toThrow(/switching the core/)
    await expect(machine.beginSwitch(machineId)).rejects.toThrow(/already switching the core/)

    release()
    const lease = await pending
    expect(machine.switchLeaseValid(lease)).toBe(true)
  })

  it('断开后仍在跑的连接尝试照样挡住切换', async () => {
    const { machine } = await import('./machine')
    // 记录挂在机器状态上：用户断开时重连状态会被清掉，但这次尝试还在跑。
    mocks.machineStates.set(machineId, {
      generation: 0,
      phase: 'disconnected',
      connectAttempting: new Promise(() => {}),
    })

    await machine.disconnect(machineId)

    await expect(machine.beginSwitch(machineId)).rejects.toThrow(/reconnecting/)
  })
})
