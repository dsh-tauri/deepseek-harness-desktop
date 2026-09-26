import type { SshMachineList } from './api'
import type { SshMachineRow } from './types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshApiHttpError } from './api'
import { bindSshApiForTests, disposeRemoteForTests, remote } from './store'

function machineOf(partial: Partial<SshMachineRow>): SshMachineRow {
  return { id: 'm1', name: 'machine', state: 'disconnected', ...partial }
}

/** SSH 已启用的 machine.list 应答。 */
function listOf(machines: SshMachineRow[]): SshMachineList {
  return { enabled: true, machines }
}

/** 组一个按调用序返回快照序列的 listMachines mock（末张快照驻留）。 */
function bindListSequence(list: SshMachineRow[][]) {
  let call = 0
  return vi.fn(async () => {
    const snapshot = list[Math.min(call, list.length - 1)] ?? []
    call += 1
    return listOf(snapshot)
  })
}

/** 注入可编程 mock 引擎：listMachines 按调用序返回快照序列。 */
function bindEngine(options: {
  list: SshMachineRow[][]
  connect?: () => Promise<{ tunnelBaseUrl: string }>
}) {
  let call = 0
  const listMachines = vi.fn(async () => {
    const snapshot = options.list[Math.min(call, options.list.length - 1)] ?? []
    call += 1
    return listOf(snapshot)
  })
  const connect = options.connect ?? (vi.fn(async () => ({ tunnelBaseUrl: 'http://127.0.0.1:4001' })))
  bindSshApiForTests({ listMachines, connect, disconnect: vi.fn(async () => undefined) })
  return { listMachines, connect }
}

beforeEach(() => {
  disposeRemoteForTests()
})

afterEach(() => {
  disposeRemoteForTests()
})

describe('remote store 轮询与降级', () => {
  it('refresh 成功更新机器列表；网络失败进入降级态并保留既有列表，恢复后复原', async () => {
    bindEngine({ list: [[machineOf({ id: 'm1', name: 'alpha' })]] })
    await remote.refresh()
    expect(remote.machines.map(m => m.name)).toEqual(['alpha'])
    expect(remote.enabled).toBe(true)
    expect(remote.available).toBe(true)

    // 本地实例不可达：fetch 抛错 → 降级但不清空列表（静默，不弹错误）
    bindSshApiForTests({
      listMachines: vi.fn(async () => { throw new TypeError('fetch failed') }),
      connect: vi.fn(async () => { throw new Error('unreachable') }),
      disconnect: vi.fn(async () => undefined),
    })
    await remote.refresh()
    expect(remote.available).toBe(false)
    expect(remote.machines.map(m => m.name)).toEqual(['alpha'])

    // 恢复
    bindEngine({ list: [[machineOf({ id: 'm1', name: 'alpha' })]] })
    await remote.refresh()
    expect(remote.available).toBe(true)
  })

  it('本地实例可达但没有 SSH API（404/405）：不算不可达，按未启用处理并清空远端视图', async () => {
    bindEngine({ list: [[machineOf({ id: 'm1', name: 'alpha' })]] })
    await remote.refresh()
    remote.activeId = 'm1'
    remote.activeTunnelUrl = 'http://127.0.0.1:4001'

    // 插件未加载 / 未启用：内核 fallback 只回 405、正文为空（0.1.7 的实况）
    bindSshApiForTests({
      listMachines: vi.fn(async () => { throw new SshApiHttpError(405) }),
      connect: vi.fn(async () => { throw new Error('unreachable') }),
      disconnect: vi.fn(async () => undefined),
    })
    await remote.refresh()
    expect(remote.available).toBe(true)
    expect(remote.enabled).toBe(false)
    expect(remote.machines).toEqual([])
    expect(remote.activeId).toBeNull()
    expect(remote.activeTunnelUrl).toBe('')

    // 用户在设置页启用插件后：下一轮轮询即恢复
    bindEngine({ list: [[machineOf({ id: 'm1', name: 'alpha' })]] })
    await remote.refresh()
    expect(remote.enabled).toBe(true)
    expect(remote.machines.map(m => m.name)).toEqual(['alpha'])
  })

  it('未启用（enabled=false）时清空列表且不推进切换', async () => {
    remote.machines = [machineOf({ id: 'm1', name: 'alpha' })]
    remote.activeId = 'm1'
    bindSshApiForTests({
      listMachines: vi.fn(async () => ({ enabled: false, machines: [] })),
      connect: vi.fn(async () => ({ tunnelBaseUrl: 'http://127.0.0.1:4001' })),
      disconnect: vi.fn(async () => undefined),
    })
    await remote.refresh()
    expect(remote.enabled).toBe(false)
    expect(remote.machines).toEqual([])
    expect(remote.activeId).toBeNull()
  })

  it('boot 幂等：只挂一个轮询定时器（fake timers 下按周期节奏发请求）', async () => {
    vi.useFakeTimers()
    try {
      const engine = bindEngine({ list: [[machineOf({ id: 'm1' })]] })
      remote.boot()
      remote.boot()
      const afterBoot = engine.listMachines.mock.calls.length
      await vi.advanceTimersByTimeAsync(6000)
      // 6 秒 = 3 个周期；boot 即时 1 次 + 每周期 1 次（无重复 boot 的翻倍）
      expect(engine.listMachines.mock.calls.length).toBeLessThanOrEqual(afterBoot + 3)
      expect(engine.listMachines.mock.calls.length).toBeGreaterThanOrEqual(afterBoot + 2)
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('remote store 远端弹窗启动寻址', () => {
  it('openInitialMachine：登记挂起并拉一轮，已连接机器直接切换', async () => {
    const engine = bindEngine({ list: [[machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]] })
    expect(remote.machines).toHaveLength(0)
    remote.openInitialMachine('m1')
    expect(remote.pendingBootMachineId).toBe('m1')
    await vi.waitFor(() => expect(remote.activeTunnelUrl).toBe('http://127.0.0.1:4001'))
    expect(engine.listMachines).toHaveBeenCalled()
    expect(remote.activeId).toBe('m1')
    expect(remote.pendingBootMachineId).toBeNull()
  })

  it('openInitialMachine：实例未就绪时不落空——后续成功轮询补切换', async () => {
    // 首轮不可达（新窗口启动时实例健康检查常未就绪），恢复后轮询推进
    bindEngine({ list: [] })
    const engine = bindEngine({ list: [] })
    engine.listMachines.mockRejectedValueOnce(new TypeError('fetch failed'))
    engine.listMachines.mockImplementation(async () =>
      listOf([machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]))
    remote.openInitialMachine('m1')
    await vi.waitFor(() => expect(remote.available).toBe(false))
    expect(remote.activeId).toBeNull()
    await remote.refresh()
    await vi.waitFor(() => expect(remote.activeTunnelUrl).toBe('http://127.0.0.1:4001'))
    expect(remote.activeId).toBe('m1')
  })

  it('openInitialMachine：未连接机器走标准连接流程（进度弹窗照常）', async () => {
    // 状态机式 mock：connect 前 disconnected、后 connected（轮询发现就绪）
    let connected = false
    const engine = bindEngine({
      list: [[]],
      connect: vi.fn(async () => {
        connected = true
        return { tunnelBaseUrl: 'http://127.0.0.1:4001' }
      }),
    })
    engine.listMachines.mockImplementation(async () =>
      listOf([machineOf(connected
        ? { id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' }
        : { id: 'm1', state: 'disconnected' })]))
    remote.openInitialMachine('m1')
    await vi.waitFor(() => expect(remote.activeTunnelUrl).toBe('http://127.0.0.1:4001'))
    expect(engine.connect).toHaveBeenCalledWith('m1')
    expect(remote.activeId).toBe('m1')
  })

  it('openInitialMachine：未知机器静默不切换（label 与列表不符的兜底）', async () => {
    bindEngine({ list: [[]] })
    remote.openInitialMachine('ghost')
    await remote.refresh()
    expect(remote.activeId).toBeNull()
    expect(remote.activeTunnelUrl).toBe('')
    // 挂起目标仍在（机器可能在后续轮询中出现），手动回本地即撤销
    expect(remote.pendingBootMachineId).toBe('ghost')
    remote.backToLocal()
    expect(remote.pendingBootMachineId).toBeNull()
  })
})

describe('remote store 切换语义', () => {
  it('switchTo 已连接机器：立即切换到隧道 URL', async () => {
    bindEngine({ list: [[machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]] })
    await remote.refresh()
    remote.switchTo('m1')
    expect(remote.activeId).toBe('m1')
    expect(remote.activeTunnelUrl).toBe('http://127.0.0.1:4001')
    expect(remote.pendingId).toBeNull()
  })

  it('switchTo 未连接机器：发起连接，就绪后自动切换（不指向空端口）', async () => {
    // 状态机式 mock：connect 调用前 disconnected，之后 connected 并给出隧道 URL
    let connected = false
    const engine = bindEngine({
      list: [[]],
      connect: vi.fn(async () => {
        connected = true
        return { tunnelBaseUrl: 'http://127.0.0.1:4002' }
      }),
    })
    engine.listMachines.mockImplementation(async () =>
      listOf([machineOf(connected
        ? { id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4002' }
        : { id: 'm1', state: 'disconnected' })]))

    await remote.refresh()
    remote.switchTo('m1')
    expect(engine.connect).toHaveBeenCalledWith('m1')
    // connectAndSwitch 内部 refresh 驱动 reconcile，就绪后升为活动
    await vi.waitFor(() => {
      expect(remote.activeId).toBe('m1')
      expect(remote.activeTunnelUrl).toBe('http://127.0.0.1:4002')
      expect(remote.pendingId).toBeNull()
    })
  })

  it('连接失败：撤销待切换留在本地，失败态经 refresh 呈现', async () => {
    bindEngine({
      list: [
        [machineOf({ id: 'm1', state: 'disconnected' })],
        [machineOf({ id: 'm1', state: 'given-up', lastError: 'connect failed after 3 attempt(s): refused' })],
      ],
      connect: vi.fn(async () => { throw new Error('machine is reconnecting') }),
    })
    await remote.refresh()
    remote.switchTo('m1')
    // connect 拒绝后 pending 清空；收尾 refresh 拉到 given-up 状态
    await vi.waitFor(() => {
      expect(remote.pendingId).toBeNull()
      expect(remote.machines[0]?.state).toBe('given-up')
      expect(remote.machines[0]?.lastError).toContain('refused')
    })
    expect(remote.activeId).toBeNull()
  })

  it('reconnecting 中点击：不重复 connect，挂起等待自动恢复', async () => {
    const engine = bindEngine({
      list: [
        [machineOf({ id: 'm1', state: 'reconnecting', nextRetryAt: Date.now() + 4000 })],
        [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })],
      ],
    })
    await remote.refresh()
    remote.switchTo('m1')
    expect(remote.pendingId).toBe('m1')
    expect(engine.connect).not.toHaveBeenCalled()
    await remote.refresh()
    expect(remote.activeId).toBe('m1')
    expect(remote.activeTunnelUrl).toBe('http://127.0.0.1:4001')
  })

  it('活动机器被断开（面板 disconnect）：轮询自动回本地', async () => {
    bindEngine({
      list: [
        [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })],
        [machineOf({ id: 'm1', state: 'disconnected' })],
      ],
    })
    await remote.refresh()
    remote.switchTo('m1')
    expect(remote.activeId).toBe('m1')
    await remote.refresh()
    expect(remote.activeId).toBeNull()
    expect(remote.activeTunnelUrl).toBe('')
  })

  it('backToLocal：回本地并撤销挂起中的切换（不抢切）', async () => {
    bindEngine({
      list: [
        [machineOf({ id: 'm1', state: 'connecting' })],
        [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })],
      ],
    })
    await remote.refresh()
    remote.switchTo('m1')
    expect(remote.pendingId).toBe('m1')
    remote.backToLocal()
    expect(remote.activeId).toBeNull()
    expect(remote.pendingId).toBeNull()
    // 用户已选本地：即便机器随后就绪也不自动切换
    await remote.refresh()
    expect(remote.activeId).toBeNull()
  })

  it('降级态下 switchTo 直接忽略（远端项在切换器中已禁用）', async () => {
    bindSshApiForTests({
      listMachines: vi.fn(async () => { throw new TypeError('fetch failed') }),
      connect: vi.fn(async () => { throw new Error('unreachable') }),
      disconnect: vi.fn(async () => undefined),
    })
    await remote.refresh()
    expect(remote.available).toBe(false)
    remote.switchTo('m1')
    expect(remote.pendingId).toBeNull()
  })

  it('disconnect：活动机器先回本地视图再向引擎发断开，随后 refresh 落定', async () => {
    const disconnectSpy = vi.fn(async () => undefined)
    bindSshApiForTests({
      listMachines: vi.fn(async () => listOf([machineOf({ id: 'm1', state: 'disconnected' })])),
      connect: vi.fn(async () => ({ tunnelBaseUrl: 'http://127.0.0.1:4001' })),
      disconnect: disconnectSpy,
    })
    remote.machines = [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    remote.enabled = true
    remote.activeId = 'm1'
    remote.activeTunnelUrl = 'http://127.0.0.1:4001'
    await remote.disconnect('m1')
    expect(disconnectSpy).toHaveBeenCalledWith('m1')
    // 视图立即回本地（不等 refresh），refresh 后引擎落定 disconnected
    expect(remote.activeId).toBeNull()
    expect(remote.activeTunnelUrl).toBe('')
    expect(remote.machines[0]?.state).toBe('disconnected')
  })

  it('连接进行中：累积走过的 progress 阶段 + 增量追加事件日志；成功自动复位', async () => {
    let release: () => void = () => {}
    bindSshApiForTests({
      listMachines: bindListSequence([
        [machineOf({ id: 'm1', state: 'disconnected' })],
        [machineOf({ id: 'm1', state: 'connecting', progress: { phase: 'installing' } })],
        [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })],
      ]),
      connect: vi.fn(() => new Promise<{ tunnelBaseUrl: string }>((resolve) => {
        release = () => resolve({ tunnelBaseUrl: 'http://127.0.0.1:4001' })
      })),
      disconnect: vi.fn(async () => undefined),
      events: vi.fn(async (_id: string, sinceSeq = 0) => ({
        items: sinceSeq === 0
          ? [{ seq: 0, line: '[handshake] ssh ok' }, { seq: 1, line: '[installing] download' }]
          : [],
      })),
    })
    await remote.refresh()
    remote.switchTo('m1')
    // 连接阻塞中：轮询 refresh 把 progress 阶段与事件增量累积进跟踪态
    await remote.refresh()
    expect(remote.connectTrail).toEqual(['installing'])
    expect(remote.connectLog).toEqual(['[handshake] ssh ok', '[installing] download'])
    // 就绪：切换完成，跟踪态自动复位（弹窗随 pendingId 清空关闭）
    release()
    await vi.waitFor(() => expect(remote.activeId).toBe('m1'))
    expect(remote.connectTrail).toEqual([])
    expect(remote.connectLog).toEqual([])
    expect(remote.connectFailed).toBeNull()
  })

  it('连接失败：定格目标与直接原因供进度弹窗呈现，dismissConnect 关闭清理', async () => {
    bindSshApiForTests({
      listMachines: vi.fn(async () => listOf([machineOf({ id: 'm1', state: 'given-up', lastError: 'timeout' })])),
      connect: vi.fn(async () => { throw new Error('dial tcp timeout') }),
      disconnect: vi.fn(async () => undefined),
      events: vi.fn(async () => ({ items: [{ seq: 0, line: '[handshake] fail' }] })),
    })
    await remote.refresh()
    remote.switchTo('m1')
    await vi.waitFor(() => expect(remote.connectFailed).toEqual({ id: 'm1', error: 'dial tcp timeout' }))
    // 失败期间的事件日志保留在弹窗里（用户可见问题所在）
    await vi.waitFor(() => expect(remote.connectLog).toEqual(['[handshake] fail']))
    remote.dismissConnect()
    expect(remote.connectFailed).toBeNull()
    expect(remote.connectLog).toEqual([])
  })

  describe('cancelConnect（取消连接）', () => {
    it('取消进行中的连接：在飞 connect 以取消错误落定时静默，不定格失败', async () => {
      let releaseConnect: (err: Error) => void = () => {}
      const engine = bindEngine({
        list: [[machineOf({ id: 'm1', state: 'disconnected' })]],
        connect: vi.fn(() => new Promise<{ tunnelBaseUrl: string }>((_resolve, reject) => {
          releaseConnect = reject
        })),
      })
      const disconnectSpy = vi.fn(async () => undefined)
      bindSshApiForTests({ listMachines: engine.listMachines, connect: engine.connect, disconnect: disconnectSpy })

      await remote.refresh()
      remote.switchTo('m1')
      expect(engine.connect).toHaveBeenCalledWith('m1')
      expect(remote.pendingId).toBe('m1')

      remote.cancelConnect('m1')
      expect(remote.pendingId).toBeNull()
      await vi.waitFor(() => expect(disconnectSpy).toHaveBeenCalledWith('m1'))

      // 引擎侧在飞 connect 以 "cancelled by disconnect" 拒绝：静默收场（不定格失败）
      releaseConnect(new Error('connect failed: connection cancelled by disconnect'))
      await vi.waitFor(() => expect(disconnectSpy).toHaveBeenCalledTimes(1))
      expect(remote.connectFailed).toBeNull()
    })
  })
})
