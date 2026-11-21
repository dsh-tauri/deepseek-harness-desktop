import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ machineId?: string, reinstall?: boolean, ackProfileMismatch?: boolean }> = []
const instanceStatus = { current: {} as Record<string, unknown> }

vi.mock('../apis/index', () => ({
  postMachinesInstall: async (body: { machineId?: string, reinstall?: boolean, ackProfileMismatch?: boolean }) => {
    calls.push(body)
    return { dshPath: '/home/u/.dsh-desktop/dependencies/dsh/lib/bin.js', credentialsCopied: false }
  },
  getCoreInstance: async () => instanceStatus.current,
  getMachines: async () => ({ items: [], discovered: [] }),
  getSessionRole: async () => ({ role: 'local', remote: false }),
}))

const { store } = await import('../store/index')
const service = await import('./machines')

beforeEach(() => {
  calls.length = 0
  store.machines.reset()
})

describe('远程安装请求', () => {
  it('一键安装不携带 reinstall，后端按缺失组件判断是否真的安装', async () => {
    await service.install({ machineId: 'm1' })

    expect(calls).toEqual([{ machineId: 'm1' }])
  })

  it('重新安装显式带 reinstall: true，让后端绕过已安装短路', async () => {
    await service.install({ machineId: 'm1', reinstall: true })

    expect(calls).toEqual([{ machineId: 'm1', reinstall: true }])
  })

  it('重新安装期间沿用 install 忙碌位，结束后释放', async () => {
    const pending = service.install({ machineId: 'm1', reinstall: true })
    expect(store.machines.busy.m1).toBe('install')

    await pending

    expect(store.machines.busy.m1).toBeUndefined()
  })

  it('确认后重装携带 ackProfileMismatch，让后端放行三态不符', async () => {
    await service.install({ machineId: 'm1', reinstall: true, ackProfileMismatch: true })

    expect(calls).toEqual([{ machineId: 'm1', reinstall: true, ackProfileMismatch: true }])
  })
})

describe('强制重装前的档案预检', () => {
  it('档案不符时返回 actual 与 expected，供 UI 弹确认框', async () => {
    instanceStatus.current = { item: { verdict: 'mismatch', actual: 'other', expected: 'remote', port: 4001 } }

    await expect(service.profileMismatchOf('m1')).resolves.toEqual({ actual: 'other', expected: 'remote' })
  })

  it('档案相符或认不出时不要求确认', async () => {
    instanceStatus.current = { item: { verdict: 'match', actual: 'remote', expected: 'remote', port: 4001 } }
    await expect(service.profileMismatchOf('m1')).resolves.toBeUndefined()

    instanceStatus.current = { item: { verdict: 'unknown', expected: 'remote', port: 4001 } }
    await expect(service.profileMismatchOf('m1')).resolves.toBeUndefined()
  })

  it('预检端点报错时不阻断重装', async () => {
    instanceStatus.current = { error: 'REMOTE_DSH_STATE_UNKNOWN' }

    await expect(service.profileMismatchOf('m1')).resolves.toBeUndefined()
  })
})
