import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners: Array<(event: { payload: Record<string, unknown> }) => void> = []
  const toast = Object.assign(vi.fn(() => 'progress-key'), {
    update: vi.fn(),
    close: vi.fn(),
    isActive: vi.fn(() => true),
  })
  return {
    listeners,
    toast,
    invoke: vi.fn(),
    restart: vi.fn(),
    invalidate: vi.fn(),
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    mocks.listeners.push(handler)
    return () => {}
  }),
}))
vi.mock('i18next', () => ({
  default: { t: (key: string, options?: Record<string, unknown>) => options?.version === undefined ? key : `${key}:${options.version}` },
}))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: mocks.invalidate } }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('../harness', () => ({ harness: { restart: mocks.restart } }))

const { coreDownload } = await import('./store')

const CORE = { id: 'app-dsh-0.2.3' }

interface ToastCall {
  title: string
  options: { variant?: string, timeout?: number, isLoading?: boolean, description?: unknown, actionProps?: { onPress: () => void } }
}

function lastToastCall(): ToastCall {
  const call = mocks.toast.mock.calls.at(-1)
  expect(call).toBeDefined()
  const [title, options] = call as unknown as [string, ToastCall['options']]
  return { title, options }
}

/** 模拟一次 install-progress 推送 */
function emitProgress(percentage: number, detail: string) {
  for (const handler of mocks.listeners)
    handler({ payload: { percentage, detail, log: '', title: '', type: 'download', progress: percentage } })
}

function progressContent() {
  const last = mocks.toast.update.mock.calls.at(-1)?.[1] as { description: unknown, title: string, isLoading: boolean } | undefined
  expect(last).toBeDefined()
  return last!
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.length = 0
  mocks.toast.mockReturnValue('progress-key')
  mocks.toast.isActive.mockReturnValue(true)
  mocks.restart.mockResolvedValue(undefined)
  mocks.invalidate.mockResolvedValue(undefined)
  coreDownload.task = null
  coreDownload.progressKey = null
})

describe('核心下载的进度气泡', () => {
  it('下载中弹一条常驻加载气泡，描述位带进度条', async () => {
    mocks.invoke.mockReturnValue(new Promise(() => {}))
    void coreDownload.start('dsh-0.2.3', '0.2.3')
    await vi.waitFor(() => expect(mocks.listeners.length).toBe(1))

    const [title, options] = mocks.toast.mock.calls[0] as unknown as [string, { timeout: number, isLoading: boolean, description: unknown }]
    expect(title).toBe('core.downloading:0.2.3')
    expect(options.timeout).toBe(0)
    expect(options.isLoading).toBe(true)
    expect(options.description).toBeTruthy()
  })

  it('进度只前进不后退，且每次推送都原地更新同一条气泡', async () => {
    mocks.invoke.mockReturnValue(new Promise(() => {}))
    void coreDownload.start('dsh-0.2.3', '0.2.3')
    await vi.waitFor(() => expect(mocks.listeners.length).toBe(1))

    emitProgress(40, '已下载 3.2 MB / 38.0 MB')
    emitProgress(20, 'stale')
    emitProgress(60, '已下载 22.0 MB / 38.0 MB')

    expect(coreDownload.task?.percentage).toBe(60)
    expect(progressContent().title).toBe('core.downloading:0.2.3')
    expect(mocks.toast.update).toHaveBeenCalledTimes(2)
    const key = (mocks.toast.update.mock.calls[0] as unknown[])[0]
    expect(key).toBe('progress-key')
  })

  it('下载成功后收起进度气泡并给出切换入口', async () => {
    mocks.invoke.mockResolvedValue(CORE)
    await coreDownload.start('dsh-0.2.3', '0.2.3')

    expect(mocks.toast.close).toHaveBeenCalledWith('progress-key')
    const { title, options } = lastToastCall()
    expect(title).toBe('core.downloaded_toast:0.2.3')
    expect(options.variant).toBe('success')
    expect(coreDownload.task?.status).toBe('success')

    options.actionProps!.onPress()
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledOnce())
  })

  it('下载失败后收起进度气泡并给出重试入口', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.invoke.mockRejectedValue(new Error('CORE_DOWNLOAD_FAILED: network unreachable'))
    await coreDownload.start('dsh-0.2.3', '0.2.3')

    expect(mocks.toast.close).toHaveBeenCalledWith('progress-key')
    const { title, options } = lastToastCall()
    expect(title).toBe('core.download_failed')
    expect(options.variant).toBe('danger')
    expect(String(options.description)).toContain('network unreachable')
    expect(coreDownload.task?.status).toBe('failed')

    mocks.invoke.mockReturnValue(new Promise(() => {}))
    mocks.listeners.length = 0
    options.actionProps!.onPress()
    await vi.waitFor(() => expect(mocks.listeners.length).toBe(1))
    expect(coreDownload.task?.status).toBe('running')
    warn.mockRestore()
  })

  it('旧气泡的切换入口不会作用到后来开始的新版本', async () => {
    mocks.invoke.mockResolvedValueOnce(CORE)
    await coreDownload.start('dsh-0.2.3', '0.2.3')
    const stale = lastToastCall()

    mocks.invoke.mockReturnValue(new Promise(() => {}))
    mocks.listeners.length = 0
    void coreDownload.start('dsh-0.2.4', '0.2.4')
    await vi.waitFor(() => expect(mocks.listeners.length).toBe(1))

    mocks.invoke.mockClear()
    stale.options.actionProps!.onPress()
    await Promise.resolve()

    expect(mocks.invoke).not.toHaveBeenCalledWith('set_active_core', expect.anything())
    expect(mocks.restart).not.toHaveBeenCalled()
    expect(coreDownload.task?.tag).toBe('dsh-0.2.4')
  })

  it('旧气泡的重试入口不会重下后来开始的新版本', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.invoke.mockRejectedValueOnce(new Error('CORE_DOWNLOAD_FAILED: network unreachable'))
    await coreDownload.start('dsh-0.2.3', '0.2.3')
    const stale = lastToastCall()

    mocks.invoke.mockReturnValue(new Promise(() => {}))
    mocks.listeners.length = 0
    void coreDownload.start('dsh-0.2.4', '0.2.4')
    await vi.waitFor(() => expect(mocks.listeners.length).toBe(1))
    emitProgress(30, '已下载 9.0 MB / 38.0 MB')

    mocks.invoke.mockClear()
    stale.options.actionProps!.onPress()
    await Promise.resolve()

    expect(mocks.invoke).not.toHaveBeenCalledWith('download_core', expect.anything())
    expect(coreDownload.task?.tag).toBe('dsh-0.2.4')
    expect(coreDownload.task?.percentage).toBe(30)
    error.mockRestore()
  })

  it('进度气泡被可见限额淘汰后重建，而不是继续更新死 key', async () => {
    mocks.invoke.mockReturnValue(new Promise(() => {}))
    void coreDownload.start('dsh-0.2.3', '0.2.3')
    await vi.waitFor(() => expect(mocks.listeners.length).toBe(1))

    mocks.toast.isActive.mockReturnValue(false)
    mocks.toast.mockReturnValue('rebuilt-key')
    emitProgress(50, '已下载 19.0 MB / 38.0 MB')

    expect(mocks.toast).toHaveBeenCalledTimes(2)
    expect(coreDownload.progressKey).toBe('rebuilt-key')
    expect(mocks.toast.update).not.toHaveBeenCalled()
  })

  it('已有任务在跑时不重复开第二条下载', async () => {
    mocks.invoke.mockReturnValue(new Promise(() => {}))
    void coreDownload.start('dsh-0.2.3', '0.2.3')
    await vi.waitFor(() => expect(mocks.listeners.length).toBe(1))

    await coreDownload.start('dsh-0.2.4', '0.2.4')

    expect(mocks.invoke).toHaveBeenCalledOnce()
    expect(coreDownload.task?.version).toBe('0.2.3')
  })
})

describe('核心下载的切换', () => {
  it('切换失败时收起气泡并重新给出失败提示', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.invoke.mockResolvedValueOnce(CORE)
    await coreDownload.start('dsh-0.2.3', '0.2.3')
    mocks.toast.mockClear()

    mocks.invoke.mockRejectedValueOnce(new Error('CORE_ACTIVATE_FAILED'))
    await coreDownload.activate('dsh-0.2.3')

    expect(mocks.restart).not.toHaveBeenCalled()
    expect(coreDownload.task?.status).toBe('failed')
    expect(lastToastCall().title).toBe('core.download_failed')
    error.mockRestore()
  })
})
