import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ machineId?: string, reinstall?: boolean }> = []

vi.mock('../apis/index', () => ({
  postMachinesInstall: async (body: { machineId?: string, reinstall?: boolean }) => {
    calls.push(body)
    return { dshPath: '/home/u/.dsh-desktop/dependencies/dsh/lib/bin.js', credentialsCopied: false }
  },
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
})
