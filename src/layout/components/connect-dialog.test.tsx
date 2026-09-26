// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSshApiForTests, disposeRemoteForTests, remote } from '@/store/modules/remote'
import { ConnectDialog } from './connect-dialog'

// i18n 直通（key 即文案）
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => params?.name !== undefined ? `${key}:${String(params.name)}` : key }),
}))

beforeEach(() => {
  disposeRemoteForTests()
})

afterEach(() => {
  cleanup()
  disposeRemoteForTests()
})

describe('connectDialog 连接进度弹窗', () => {
  it('pending 时打开：标题含机器名、步骤条只显示走过的阶段、日志尾呈现', async () => {
    remote.machines = [{ id: 'm1', name: 'alpha', state: 'connecting', progress: { phase: 'installing' } }]
    remote.pendingId = 'm1'
    remote.connectTrail = ['handshake', 'installing']
    remote.connectLog = ['[handshake] ssh ok', '[installing] download 42%']
    render(<ConnectDialog />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByText('remote.connect.title:alpha')).toBeTruthy()
    const steps = screen.getByTestId('connect-steps')
    expect(steps.textContent).toContain('remote.step.handshake')
    expect(steps.textContent).toContain('remote.step.installing')
    // 未走过的阶段不出现
    expect(steps.textContent).not.toContain('remote.step.starting')
    expect(screen.getByText('[installing] download 42%')).toBeTruthy()
    expect(screen.getByText('remote.connect.working')).toBeTruthy()
  })

  it('无 pending 且无失败定格：不渲染弹窗', () => {
    render(<ConnectDialog />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('失败定格：直接原因 + 重试按钮（重试重新发起连接）', async () => {
    const connectSpy = vi.fn(() => new Promise<{ tunnelBaseUrl: string }>(() => {}))
    bindSshApiForTests({
      listMachines: vi.fn(async () => ({ enabled: true, machines: [{ id: 'm1', name: 'alpha', state: 'given-up' as const, lastError: 'boom' }] })),
      connect: connectSpy,
      disconnect: vi.fn(async () => undefined),
    })
    remote.machines = [{ id: 'm1', name: 'alpha', state: 'given-up', lastError: 'boom' }]
    remote.connectFailed = { id: 'm1', error: 'dial tcp timeout' }
    remote.connectLog = ['[handshake] fail']
    render(<ConnectDialog />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByText('remote.connect.failed_title')).toBeTruthy()
    expect(screen.getByText('dial tcp timeout')).toBeTruthy()
    fireEvent.click(screen.getByText('remote.connect.retry'))
    // 重试：失败定格清除并重新挂起连接
    await waitFor(() => expect(remote.connectFailed).toBeNull())
    expect(remote.pendingId).toBe('m1')
    await waitFor(() => expect(connectSpy).toHaveBeenCalledWith('m1'))
  })

  it('取消连接（进行中）：中止引擎尝试并关闭弹窗，无失败定格', async () => {
    const disconnectSpy = vi.fn(async () => undefined)
    bindSshApiForTests({
      listMachines: vi.fn(async () => ({ enabled: true, machines: [] })),
      connect: vi.fn(async () => ({ tunnelBaseUrl: 'http://127.0.0.1:1' })),
      disconnect: disconnectSpy,
    })
    remote.machines = [{ id: 'm1', name: 'alpha', state: 'connecting' }]
    remote.pendingId = 'm1'
    remote.connectTrail = ['handshake']
    remote.connectLog = ['[handshake] ssh ok']
    render(<ConnectDialog />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.click(screen.getByTestId('connect-cancel'))
    // 取消：断开下发、挂起与跟踪清空、弹窗关闭，且无失败定格
    await waitFor(() => expect(disconnectSpy).toHaveBeenCalledWith('m1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remote.pendingId).toBeNull()
    expect(remote.connectFailed).toBeNull()
    expect(remote.connectLog).toEqual([])
  })

  it('关闭（进行中）：弹窗关闭、跟踪态清理，pending 语义不撤销', async () => {
    remote.machines = [{ id: 'm1', name: 'alpha', state: 'connecting' }]
    remote.pendingId = 'm1'
    remote.connectLog = ['[handshake] ssh ok']
    render(<ConnectDialog />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remote.connectLog).toEqual([])
    // 关闭只是隐藏：连接挂起仍在（后台继续，就绪后自动切换）
    expect(remote.pendingId).toBe('m1')
  })
})
