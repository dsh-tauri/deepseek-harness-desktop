// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { act, cleanup, fireEvent, render as renderElement, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en-US.json'
import zh from '@/i18n/locales/zh-CN.json'
import { RemoteShare } from './remote-share'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const getAccessSpy = vi.fn<(params?: { sincePairingUseSeq?: number }) => Promise<unknown>>()
const postAccessSpy = vi.fn<(body: unknown) => Promise<unknown>>()
const postAccessTunnelSpy = vi.fn<(body: unknown) => Promise<unknown>>()
const deleteAccessTunnelSpy = vi.fn<() => Promise<unknown>>()
vi.mock('@/apis/remote', () => ({
  getAccess: (params?: { sincePairingUseSeq?: number }) => getAccessSpy(params),
  postAccess: (body: unknown) => postAccessSpy(body),
  postAccessTunnel: (body: unknown) => postAccessTunnelSpy(body),
  deleteAccessTunnel: () => deleteAccessTunnelSpy(),
}))

const openUrlSpy = vi.fn<(args: { url: string }) => Promise<void>>()
const clipboardSpy = vi.fn<(text: string, message?: string) => Promise<void>>()
vi.mock('@/utils/clipboard', () => ({
  writeClipboardText: (text: string, message?: string) => clipboardSpy(text, message),
}))

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

if (typeof CSS === 'undefined')
  vi.stubGlobal('CSS', { escape: (value: string) => value })

Element.prototype.getAnimations = function () {
  return []
}

let queryClient: QueryClient

function render(element: ReactElement) {
  return renderElement(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>)
}

const QR = 'data:image/png;base64,qr'
const PAIR_CODE = '482913'
const LAN_LINK = 'http://192.168.1.5:3080/?auth=482913'
const TUNNEL_LINK = 'https://demo.trycloudflare.com/?auth=482913'

function pairingOf(patch: Record<string, unknown> = {}) {
  return {
    code: PAIR_CODE,
    expiresAt: Date.now() + 300_000,
    link: LAN_LINK,
    qr: QR,
    ...patch,
  }
}

function statusOf(patch: Record<string, unknown> = {}) {
  return {
    version: 1,
    enabled: true,
    state: 'stopped',
    listening: false,
    listen: { address: '0.0.0.0', port: 3080 },
    port: 3080,
    linkSource: 'lan',
    tunnel: { enabled: false, mode: 'quick', hostname: null, state: 'stopped', events: [] },
    ...patch,
  }
}

const listening = {
  state: 'listening',
  listening: true,
  link: LAN_LINK,
  maskLink: 'http://192.168.1.5:3080/?auth=***',
  qr: QR,
  pairing: pairingOf(),
}

async function openShare() {
  fireEvent.click(screen.getByRole('button', { name: 'remote.share' }))
  await screen.findByRole('dialog')
}

function clickTunnelTab() {
  fireEvent.click(screen.getByText('remote.share.tab_tunnel'))
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } })
  openUrlSpy.mockReset().mockResolvedValue(undefined)
  mockIPC((command, args) => {
    if (command === 'open_external_url')
      return openUrlSpy(args as { url: string })
    throw new Error(`Unexpected native command: ${command}`)
  })
  getAccessSpy.mockReset()
  postAccessSpy.mockReset()
  postAccessTunnelSpy.mockReset()
  deleteAccessTunnelSpy.mockReset()
  clipboardSpy.mockReset()
  clipboardSpy.mockResolvedValue(undefined)
  getAccessSpy.mockResolvedValue(statusOf())
  postAccessSpy.mockResolvedValue(statusOf(listening))
  postAccessTunnelSpy.mockResolvedValue(statusOf())
  deleteAccessTunnelSpy.mockResolvedValue(statusOf())
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  clearMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function consumedStatus(usedSeq: number, code = '735026') {
  return statusOf({ ...listening, pairing: pairingOf({ usedSeq, code, link: `http://192.168.1.5:3080/?auth=${code}` }) })
}

function mockPairingWatch(usedSeq = 0) {
  let current = consumedStatus(usedSeq, PAIR_CODE)
  const polls: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
  getAccessSpy.mockImplementation((params) => {
    if (params?.sincePairingUseSeq !== undefined) {
      const poll = Promise.withResolvers<unknown>()
      polls.push(poll)
      return poll.promise
    }
    return Promise.resolve({ ...current })
  })
  return {
    polls,
    update(next: ReturnType<typeof statusOf>) {
      current = next
    },
  }
}

function closeShare() {
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
}

describe('remoteShare 临时码消费订阅', () => {
  it('显示消费基线后立即长轮询，使用响应到达即关闭，重开显示新码并订阅新基线', async () => {
    const watch = mockPairingWatch()
    render(<RemoteShare />)
    await openShare()
    expect((await screen.findByTestId('remote-share-pairing')).textContent).toBe(PAIR_CODE)
    await waitFor(() => expect(getAccessSpy).toHaveBeenCalledWith({ sincePairingUseSeq: 0 }))
    expect(watch.polls).toHaveLength(1)

    const next = consumedStatus(1)
    watch.update(next)
    await act(async () => watch.polls[0]!.resolve(next))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(getAccessSpy).toHaveBeenCalledTimes(2)
    await openShare()
    expect((await screen.findByTestId('remote-share-pairing')).textContent).toBe('735026')
    await waitFor(() => expect(getAccessSpy).toHaveBeenCalledWith({ sincePairingUseSeq: 1 }))
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(watch.polls).toHaveLength(2)
  })

  it('同一消费序号的超时响应继续订阅，TTL 换码不关闭', async () => {
    const watch = mockPairingWatch(4)
    render(<RemoteShare />)
    await openShare()
    await waitFor(() => expect(watch.polls).toHaveLength(1))
    const renewed = consumedStatus(4)
    watch.update(renewed)
    await act(async () => watch.polls[0]!.resolve(renewed))

    await waitFor(() => expect(watch.polls).toHaveLength(2))
    expect(getAccessSpy).toHaveBeenLastCalledWith({ sincePairingUseSeq: 4 })
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(screen.getByTestId('remote-share-pairing').textContent).toBe(PAIR_CODE)
  })

  it('长轮询失败不关闭，常规状态刷新后重新订阅', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const watch = mockPairingWatch()
    render(<RemoteShare />)
    await openShare()
    await waitFor(() => expect(watch.polls).toHaveLength(1))
    await act(async () => watch.polls[0]!.reject(new Error('connection lost')))
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(watch.polls).toHaveLength(1)

    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(watch.polls).toHaveLength(2)
  })

  it.each([undefined, '1', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('旧宿主或非法 marker %s 不启动忙循环', async (usedSeq) => {
    getAccessSpy.mockResolvedValue(statusOf({ ...listening, pairing: pairingOf({ usedSeq }) }))
    render(<RemoteShare />)
    await openShare()
    await screen.findByTestId('remote-share-pairing')
    expect(getAccessSpy.mock.calls).toEqual([[undefined]])
    expect(screen.getByRole('dialog')).not.toBeNull()
  })

  it('手动关闭后重开，旧订阅迟到的消费响应不关闭新弹层或覆盖新码', async () => {
    const watch = mockPairingWatch()
    render(<RemoteShare />)
    await openShare()
    await waitFor(() => expect(watch.polls).toHaveLength(1))
    closeShare()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    watch.update(consumedStatus(1))
    await openShare()
    await waitFor(() => expect(watch.polls).toHaveLength(2))

    await act(async () => watch.polls[0]!.resolve(consumedStatus(1, '999999')))

    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(screen.getByTestId('remote-share-pairing').textContent).toBe('735026')
    expect(getAccessSpy).toHaveBeenCalledTimes(4)
  })

  it('卸载后迟到的消费响应不拉起新请求或影响下一次挂载', async () => {
    const watch = mockPairingWatch()
    const view = render(<RemoteShare />)
    await openShare()
    await waitFor(() => expect(watch.polls).toHaveLength(1))
    view.unmount()
    await act(async () => watch.polls[0]!.resolve(consumedStatus(1)))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(getAccessSpy).toHaveBeenCalledTimes(2)

    render(<RemoteShare />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(getAccessSpy).toHaveBeenCalledTimes(2)
  })

  it('长轮询消费响应到达时动作锁仍守住结果，动作完成后立即刷新并关闭', async () => {
    const watch = mockPairingWatch()
    const mutation = Promise.withResolvers<unknown>()
    postAccessTunnelSpy.mockReturnValue(mutation.promise)
    render(<RemoteShare />)
    await openShare()
    await waitFor(() => expect(watch.polls).toHaveLength(1))
    clickTunnelTab()
    fireEvent.click(screen.getByText('remote.share.tunnel_enable'))
    await waitFor(() => expect(postAccessTunnelSpy).toHaveBeenCalledTimes(1))
    await act(async () => watch.polls[0]!.resolve(consumedStatus(1)))
    expect(screen.getByRole('dialog')).not.toBeNull()

    await act(async () => mutation.resolve(statusOf({
      ...listening,
      pairing: pairingOf({ usedSeq: 1, code: '735026' }),
      tunnel: { state: 'running', mode: 'quick' },
    })))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    watch.update(statusOf({
      ...listening,
      pairing: pairingOf({ usedSeq: 1, code: '735026' }),
      tunnel: { state: 'running', mode: 'quick' },
    }))
    await openShare()
    clickTunnelTab()
    expect((await screen.findByText('remote.share.tunnel_stop') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('remoteShare 远程分享弹层', () => {
  it('未打开弹层时不拉取状态', () => {
    render(<RemoteShare onManage={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(getAccessSpy).not.toHaveBeenCalled()
  })

  it('弹层由「远程」按钮开合，Esc 可关闭', async () => {
    render(<RemoteShare onManage={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'remote.share' })
    expect(screen.queryByTestId('remote-share-panel')).toBeNull()

    fireEvent.click(trigger)
    expect(await screen.findByTestId('remote-share-panel')).not.toBeNull()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('remote-share-panel')).toBeNull())
  })

  it('dSH Mobile 卡显示用途，整块点击在系统浏览器打开 releases', async () => {
    render(<RemoteShare />)
    await openShare()
    const mobile = screen.getByRole('button', { name: 'remote.share.mobile remote.share.mobile_hint' })
    expect(mobile.querySelector('svg')).not.toBeNull()
    expect(screen.queryByText('remote.share.mobile_pending')).toBeNull()
    expect(screen.queryByText('remote.share.mobile_released')).toBeNull()

    fireEvent.click(screen.getByText('remote.share.mobile_hint'))

    await waitFor(() => expect(openUrlSpy).toHaveBeenCalledExactlyOnceWith({
      url: 'https://github.com/dsh-tauri/deepseek-harness-desktop/releases',
    }))
  })

  it('dSH Mobile 外链打开失败在弹层显示错误', async () => {
    openUrlSpy.mockRejectedValue(new Error('browser unavailable'))
    render(<RemoteShare />)
    await openShare()

    fireEvent.click(screen.getByText('remote.share.mobile'))

    expect(await screen.findByText(/browser unavailable/u)).not.toBeNull()
  })

  it('局域网未开启：只给开启入口，动作成功后立刻显示新的可达链接', async () => {
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    expect(await screen.findByText('remote.share.lan_enable')).toBeTruthy()

    fireEvent.click(screen.getByText('remote.share.lan_enable'))

    await waitFor(() => expect(postAccessSpy).toHaveBeenCalledWith({ enabled: true }))
    expect(await screen.findByText(LAN_LINK)).toBeTruthy()
  })

  it('局域网未开启：有待选地址时带推荐的非回环地址，跳过回环与未推荐项', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      addresses: [
        { address: '127.0.0.1', recommended: true },
        { address: '10.0.0.9', recommended: false },
        { address: '192.168.1.5', recommended: true },
      ],
    }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()

    fireEvent.click(await screen.findByText('remote.share.lan_enable'))

    await waitFor(() => expect(postAccessSpy).toHaveBeenCalledWith({ enabled: true, address: '192.168.1.5' }))
  })

  it('局域网已开启：显示链接、二维码与复制按钮', async () => {
    getAccessSpy.mockResolvedValue(statusOf(listening))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()

    const link = await screen.findByText(LAN_LINK)
    expect(link.className).toContain('truncate')
    expect(link.tagName).toBe('DIV')
    expect(link.className).not.toContain('break-all')
    expect(screen.getByRole('img', { name: 'remote.share.qr_alt' }).getAttribute('src')).toBe(QR)
    expect(screen.queryByText('remote.share.lan_local_only')).toBeNull()
    expect(screen.queryByText('remote.share.lan_state.listening')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'remote.share.copy' }))
    await waitFor(() => expect(clipboardSpy).toHaveBeenCalledWith(LAN_LINK, 'remote.share.copied'))
  })

  it('回环来源：不给链接、二维码与复制，只给仅本机可用的提示', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      ...listening,
      link: 'http://127.0.0.1:3080/?auth=482913',
      maskLink: 'http://127.0.0.1:3080/?auth=***',
      pairing: pairingOf({ link: 'http://127.0.0.1:3080/?auth=482913' }),
    }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()

    expect(await screen.findByText('remote.share.lan_local_only')).toBeTruthy()
    expect(screen.queryByText(/127\.0\.0\.1/u)).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText('remote.share.copy')).toBeNull()
  })

  it('隧道关闭：只显示启用入口', async () => {
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    clickTunnelTab()

    const offDescription = await screen.findByText('remote.share.tunnel_off_desc')
    expect(offDescription.className).toContain('text-center')
    expect(offDescription.className).toContain('block')
    expect(offDescription.className).toMatch(/pb-/u)
    expect(await screen.findByText('remote.share.tunnel_enable')).toBeTruthy()
    expect(screen.queryByText('remote.share.tunnel_failed')).toBeNull()
  })

  it('下载阶段只显示下载文案与进度，不叠加正在启动隧道', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      tunnel: { state: 'starting', mode: 'quick', progress: { stage: 'download', received: 1048576, total: 4194304 } },
    }))
    render(<RemoteShare />)
    await openShare()
    clickTunnelTab()

    await screen.findByRole('progressbar')
    expect(screen.getAllByText('remote.share.stage.download')).toHaveLength(1)
    expect(screen.getByText('remote.share.download_progress').textContent).toBe('remote.share.download_progress')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
    expect(screen.queryByText(/remote\.share\.tunnel_starting/u)).toBeNull()
  })

  it.each([undefined, 0])('下载总量 %s 时仍显示不定进度，不叠加启动文案', async (total) => {
    getAccessSpy.mockResolvedValue(statusOf({
      tunnel: { state: 'starting', mode: 'quick', progress: { stage: 'download', received: 1048576, total } },
    }))
    render(<RemoteShare />)
    await openShare()
    clickTunnelTab()

    await screen.findByRole('progressbar')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
    expect(screen.getAllByText('remote.share.stage.download')).toHaveLength(1)
    expect(screen.getByText('remote.share.download_received').textContent).toBe('remote.share.download_received')
    expect(screen.queryByText(/remote\.share\.tunnel_starting/u)).toBeNull()
  })

  it('下载结束后的启动阶段不再展示残留下载字节', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      tunnel: { state: 'starting', mode: 'quick', progress: { stage: 'spawn', received: 4194304, total: 4194304 } },
    }))
    render(<RemoteShare />)
    await openShare()
    clickTunnelTab()

    expect((await screen.findByText(/remote\.share\.tunnel_starting/u)).textContent).toBe('remote.share.tunnel_starting（remote.share.stage.spawn）')
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText('remote.share.stage.download')).toBeNull()
  })

  it('隧道失败：显示原因并可重试', async () => {
    postAccessTunnelSpy.mockResolvedValue(statusOf({
      pairing: pairingOf({ tunnelLink: TUNNEL_LINK, tunnelQr: QR }),
      tunnel: { state: 'running', mode: 'quick', link: TUNNEL_LINK, qr: QR },
    }))
    getAccessSpy.mockResolvedValue(statusOf({ tunnel: { state: 'error', mode: 'quick', error: 'dial failed' } }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    clickTunnelTab()

    expect(await screen.findByText(/dial failed/)).toBeTruthy()
    fireEvent.click(screen.getByText('remote.connect.retry'))

    await waitFor(() => expect(postAccessTunnelSpy).toHaveBeenCalledWith({ mode: 'quick' }))
    expect(await screen.findByText(TUNNEL_LINK)).toBeTruthy()
  })

  it('隧道就绪：显示隧道链接、二维码与临时配对码', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      pairing: pairingOf({ tunnelLink: TUNNEL_LINK, tunnelQr: QR }),
      tunnel: { state: 'running', mode: 'quick', link: 'https://demo.trycloudflare.com/?auth=tok', qr: QR },
    }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    clickTunnelTab()

    const link = await screen.findByText(TUNNEL_LINK)
    expect(link.className).toContain('truncate')
    expect(link.tagName).toBe('DIV')
    expect(link.className).not.toContain('break-all')
    const code = screen.getByTestId('remote-share-pairing')
    expect(code.textContent).toBe(PAIR_CODE)
    expect(code.previousElementSibling?.textContent).toBe('remote.share.pairing_expires')
    expect(screen.getByText('remote.share.pairing_expires')).toBeTruthy()
    expect(screen.getByText('remote.share.pairing_hint')).toBeTruthy()
  })

  it('配对码过期：重新拉取状态换新码，且不因同一过期时间反复重试', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      pairing: pairingOf({ expiresAt: Date.now() - 1000 }),
      tunnel: { state: 'running', mode: 'quick' },
    }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    clickTunnelTab()

    expect(await screen.findByTestId('remote-share-pairing')).toBeTruthy()
    await waitFor(() => expect(getAccessSpy).toHaveBeenCalledTimes(2))
    expect(getAccessSpy).toHaveBeenCalledTimes(2)
  })

  it('只开隧道、不开局域网：局域网栏给仅本机提示，隧道栏仍给短期链接与二维码', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      pairing: { code: PAIR_CODE, expiresAt: Date.now() + 300_000, tunnelLink: TUNNEL_LINK, tunnelQr: QR },
      tunnel: { state: 'running', mode: 'quick' },
    }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()

    expect(await screen.findByText('remote.share.lan_off_desc')).toBeTruthy()
    clickTunnelTab()

    await screen.findByText(TUNNEL_LINK)
    expect(screen.getByText(TUNNEL_LINK)).toBeTruthy()
    expect(screen.getByRole('img', { name: 'remote.share.qr_alt' }).getAttribute('src')).toBe(QR)
    expect(screen.getByTestId('remote-share-pairing').textContent).toBe(PAIR_CODE)
  })

  it('旧动作回包的访问密码不再展示，分享仅保留配对码与链接', async () => {
    postAccessSpy.mockResolvedValue(statusOf({ ...listening, generatedPassword: 'Gen-Pass-1234' }))
    render(<RemoteShare />)
    await openShare()
    fireEvent.click(await screen.findByText('remote.share.lan_enable'))

    expect((await screen.findByTestId('remote-share-pairing')).textContent).toBe(PAIR_CODE)
    expect(screen.getByText(LAN_LINK).textContent).toBe(LAN_LINK)
    expect(screen.queryByTestId('remote-share-password')).toBeNull()
    expect(screen.queryByText('Gen-Pass-1234')).toBeNull()
    expect(screen.queryByText('remote.share.password')).toBeNull()
  })

  it('两种语言移除访问密码文案，保留 SSH 密码与未知总量下载提示', () => {
    for (const locale of [en, zh]) {
      expect(Object.keys(locale).filter(key => key.startsWith('remote.share.password'))).toEqual([])
      expect(locale['remote.auth.password']).toBeTypeOf('string')
      expect(locale).toHaveProperty('remote.share.download_received', '{{received}} MB')
    }
  })

  it('首次隧道下载尚未返回时持续轮询进度，较旧动作快照不覆盖刚取得的下载', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const mutation = Promise.withResolvers<unknown>()
    postAccessTunnelSpy.mockReturnValue(mutation.promise)
    getAccessSpy.mockResolvedValueOnce(statusOf()).mockResolvedValue(statusOf({
      tunnel: { enabled: true, mode: 'quick', state: 'starting', progress: { stage: 'download', received: 1048576, total: 4194304 } },
    }))
    render(<RemoteShare />)
    await openShare()
    await screen.findByText('remote.share.lan_enable')
    clickTunnelTab()
    fireEvent.click(screen.getByText('remote.share.tunnel_enable'))
    await waitFor(() => expect(postAccessTunnelSpy).toHaveBeenCalledExactlyOnceWith({ mode: 'quick' }))

    await act(async () => vi.advanceTimersByTimeAsync(5000))

    expect(getAccessSpy).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
    expect(screen.queryByText('remote.share.tunnel_off_desc')).toBeNull()
    expect(screen.queryByText(/remote\.share\.tunnel_starting/u)).toBeNull()
    expect((screen.getByText('remote.share.tunnel_stop') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => mutation.resolve(statusOf()))
    await waitFor(() => expect((screen.getByText('remote.share.tunnel_stop') as HTMLButtonElement).disabled).toBe(false))

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
    expect(screen.queryByText('remote.share.tunnel_enable')).toBeNull()
  })

  it('启动动作结束后忽略在结束前捕获的轮询快照，后续轮询仍可更新为运行', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const mutation = Promise.withResolvers<unknown>()
    const poll = Promise.withResolvers<unknown>()
    postAccessTunnelSpy.mockReturnValue(mutation.promise)
    getAccessSpy.mockResolvedValueOnce(statusOf()).mockReturnValueOnce(poll.promise)
    render(<RemoteShare />)
    await openShare()
    await screen.findByText('remote.share.lan_enable')
    clickTunnelTab()
    fireEvent.click(screen.getByText('remote.share.tunnel_enable'))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(getAccessSpy).toHaveBeenCalledTimes(2)

    const running = statusOf({
      pairing: pairingOf({ tunnelLink: TUNNEL_LINK, tunnelQr: QR }),
      tunnel: { state: 'running', mode: 'quick' },
    })
    getAccessSpy.mockResolvedValue(running)
    await act(async () => mutation.resolve(running))
    expect(screen.getByText(TUNNEL_LINK).textContent).toBe(TUNNEL_LINK)
    await act(async () => poll.resolve(statusOf({ tunnel: { state: 'starting', progress: { stage: 'download', received: 1, total: 2 } } })))
    expect(screen.getByText(TUNNEL_LINK).textContent).toBe(TUNNEL_LINK)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect((screen.getByText('remote.share.tunnel_stop') as HTMLButtonElement).disabled).toBe(false)
  })

  it('普通轮询乱序返回时，旧 stopped 快照不覆盖新下载进度', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const older = Promise.withResolvers<unknown>()
    const newer = Promise.withResolvers<unknown>()
    getAccessSpy.mockResolvedValueOnce(statusOf()).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    render(<RemoteShare />)
    await openShare()
    await screen.findByText('remote.share.lan_enable')
    clickTunnelTab()
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(getAccessSpy).toHaveBeenCalledTimes(3)

    await act(async () => newer.resolve(statusOf({ tunnel: { state: 'starting', progress: { stage: 'download', received: 1, total: 2 } } })))
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    await act(async () => older.resolve(statusOf()))
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    expect(screen.queryByText('remote.share.tunnel_enable')).toBeNull()
  })

  it('长启动请求失败后仍给出错误并解除按钮锁，不被进度 polling 掩盖', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const mutation = Promise.withResolvers<unknown>()
    postAccessTunnelSpy.mockReturnValue(mutation.promise)
    getAccessSpy.mockResolvedValueOnce(statusOf()).mockResolvedValue(statusOf({
      tunnel: { state: 'starting', progress: { stage: 'download', received: 1, total: 2 } },
    }))
    render(<RemoteShare />)
    await openShare()
    await screen.findByText('remote.share.lan_enable')
    clickTunnelTab()
    fireEvent.click(screen.getByText('remote.share.tunnel_enable'))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(getAccessSpy).toHaveBeenCalledTimes(2)
    await act(async () => mutation.reject(new Error('download denied')))

    expect(screen.getByText(/download denied/u).textContent).toContain('download denied')
    expect((screen.getByText('remote.share.tunnel_stop') as HTMLButtonElement).disabled).toBe(false)
  })

  it('齿轮保留在标题右侧且打通设置定位链路，缺席时点击不动作', async () => {
    const manageSpy = vi.fn()
    const { unmount } = render(<RemoteShare onManage={manageSpy} />)
    await openShare()
    const gear = screen.getByRole('button', { name: 'remote.share.settings' })
    const heading = screen.getByRole('heading', { name: 'remote.share' })
    expect(gear.parentElement).toBe(heading.parentElement)
    expect(gear.parentElement?.contains(screen.getByRole('tablist'))).toBe(false)
    expect(gear.className).toContain('ml-auto')
    fireEvent.click(gear)
    expect(manageSpy).toHaveBeenCalledTimes(1)
    unmount()

    render(<RemoteShare />)
    await openShare()
    fireEvent.click(screen.getByRole('button', { name: 'remote.share.settings' }))
    expect(manageSpy).toHaveBeenCalledTimes(1)
  })
})
