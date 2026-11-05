// @vitest-environment jsdom
import type { Remote } from '@/hooks/use-remote'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectDialog } from './connect-dialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => params?.name !== undefined ? `${key}:${String(params.name)}` : key }),
}))

function remoteOf(overrides: Partial<Remote> = {}): Remote {
  return {
    machines: [],
    enabled: true,
    available: true,
    activeId: null,
    pendingId: null,
    activeTunnelUrl: '',
    connectTrail: [],
    connectLog: [],
    connectFailed: null,
    connectDismissed: false,
    switchTo: vi.fn(),
    backToLocal: vi.fn(),
    disconnect: vi.fn(),
    dismissConnect: vi.fn(),
    refresh: vi.fn<Remote['refresh']>(),
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('connectDialog 连接进度弹窗', () => {
  it('pending 时打开：标题含机器名、步骤条只显示走过的阶段、日志尾呈现', async () => {
    const remote = remoteOf({
      machines: [{ id: 'm1', name: 'alpha', state: 'connecting', progress: { phase: 'installing' } }],
      pendingId: 'm1',
      connectTrail: ['handshake', 'installing'],
      connectLog: ['[handshake] ssh ok', '[installing] download 42%'],
    })
    render(<ConnectDialog remote={remote} />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByText('remote.connect.title:alpha')).toBeTruthy()
    const steps = screen.getByTestId('connect-steps')
    expect(steps.textContent).toContain('remote.step.handshake')
    expect(steps.textContent).toContain('remote.step.installing')
    expect(steps.textContent).not.toContain('remote.step.starting')
    expect(screen.getByText('[installing] download 42%')).toBeTruthy()
    expect(screen.getByText('remote.connect.working')).toBeTruthy()
  })

  it('无 pending 且无失败定格：不渲染弹窗', () => {
    render(<ConnectDialog remote={remoteOf()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('失败定格：直接原因 + 重试按钮（重试重新发起连接）', async () => {
    const connectSpy = vi.fn()
    let remote = remoteOf({
      machines: [{ id: 'm1', name: 'alpha', state: 'given-up', lastError: 'boom' }],
      connectFailed: { id: 'm1', error: 'dial tcp timeout' },
      connectLog: ['[handshake] fail'],
      switchTo: connectSpy,
    })
    const { rerender } = render(<ConnectDialog remote={remote} />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByText('remote.connect.failed_title')).toBeTruthy()
    expect(screen.getByText('dial tcp timeout')).toBeTruthy()
    fireEvent.click(screen.getByText('remote.connect.retry'))
    await waitFor(() => expect(connectSpy).toHaveBeenCalledWith('m1'))
    expect(remote.dismissConnect).toHaveBeenCalledOnce()
    remote = {
      ...remote,
      machines: [{ id: 'm1', name: 'alpha', state: 'connecting' }],
      connectFailed: null,
      pendingId: 'm1',
      connectLog: [],
    }
    rerender(<ConnectDialog remote={remote} />)
    await waitFor(() => expect(remote.connectFailed).toBeNull())
    expect(remote.pendingId).toBe('m1')
    expect(screen.queryByText('dial tcp timeout')).toBeNull()
    expect(screen.getByText('remote.connect.working')).toBeTruthy()
  })

  it('取消连接（进行中）：中止引擎尝试并关闭弹窗，无失败定格', async () => {
    const cancelSpy = vi.fn()
    let remote = remoteOf({
      machines: [{ id: 'm1', name: 'alpha', state: 'connecting' }],
      pendingId: 'm1',
      connectTrail: ['handshake'],
      connectLog: ['[handshake] ssh ok'],
      disconnect: cancelSpy,
    })
    const { rerender } = render(<ConnectDialog remote={remote} />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.click(screen.getByTestId('connect-cancel'))
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith('m1'))
    remote = { ...remote, pendingId: null, connectTrail: [], connectLog: [] }
    rerender(<ConnectDialog remote={remote} />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remote.pendingId).toBeNull()
    expect(remote.connectFailed).toBeNull()
    expect(remote.connectLog).toEqual([])
  })

  it('关闭（进行中）：弹窗关闭、跟踪态清理，pending 语义不撤销', async () => {
    let remote = remoteOf({
      machines: [{ id: 'm1', name: 'alpha', state: 'connecting' }],
      pendingId: 'm1',
      connectLog: ['[handshake] ssh ok'],
    })
    const { rerender } = render(<ConnectDialog remote={remote} />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(remote.dismissConnect).toHaveBeenCalledOnce())
    expect(remote.disconnect).not.toHaveBeenCalled()
    remote = { ...remote, connectDismissed: true, connectTrail: [], connectLog: [] }
    rerender(<ConnectDialog remote={remote} />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remote.connectLog).toEqual([])
    expect(remote.pendingId).toBe('m1')
  })
})
