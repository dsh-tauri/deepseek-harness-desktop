// @vitest-environment jsdom
import type { RemoteKey } from '../locales/index'
import type { WireCall, WireReply } from '../test-utils/client-mock'
import { fireEvent, screen, waitFor } from '@testing-library/dom'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../locales/index'
import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import { AccessSection } from './access-section'

vi.mock('dsh-tauri-ui/client', async () => ({
  ...(await import('../test-utils/ui-mock')).uiMock,
  StateDot: ({ state }: { state: string }) => <span data-testid="state-dot" data-state={state} />,
}))
vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as (key: RemoteKey) => string

const BASE = '/api/tauri/remote/access'
const TUNNEL = `${BASE}/tunnel`
const TOKEN = `${BASE}/token`
const LAN_SWITCH = en['access.lan.title']
const TUNNEL_SWITCH = en['access.tunnel.title']
const PERMANENT = '01234567'
const MASKED = '••••••••'
const REMOVED = [
  'access-auth-toggle',
  'access-auth-scope',
  'access-permanent-state',
  'access-permanent-copy',
  'access-pairing-copy',
  'access-pairing-link',
  'access-pairing-qr',
  'access-generated-password',
  'access-generated-password-value',
  'access-generated-password-dismiss',
  'access-logs-toggle',
  'access-events',
  'access-tunnel-events',
]

function authPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: true, scope: 'all', hasToken: true, ...overrides }
}

function tunnelPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: false, mode: 'quick', hostname: null, state: 'stopped', ...overrides }
}

function pairingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: 'AB12CD34', expiresAt: Date.now() + 300_000, ...overrides }
}

function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    state: 'listening',
    listening: true,
    listen: { address: '192.168.1.5', port: 3088 },
    port: 3088,
    auth: authPayload({ enabled: false, scope: 'public_only' }),
    addresses: [{ address: '192.168.1.5', family: 'ipv4', interface: 'en0', scope: 'private', score: 120, recommended: true }],
    recommended: '192.168.1.5',
    tunnel: tunnelPayload(),
    localPort: 3080,
    events: [],
    ...overrides,
  }
}

function lanOff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return statusPayload({ enabled: false, listening: false, state: 'stopped', ...overrides })
}

let queued: WireReply[] = []
let route: (call: WireCall) => WireReply = () => replies.ok(statusPayload())

function once(...next: WireReply[]): void {
  queued.push(...next)
}

function getCalls(url: string, http: string): WireCall[] {
  return sent.filter(call => call.url === url && call.http === http)
}

function lanSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: LAN_SWITCH })
}

beforeEach(() => {
  resetWire()
  store.access.reset()
  queued = []
  route = () => replies.ok(statusPayload())
  answer(call => queued.shift() ?? route(call))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('接入面板', () => {
  it('首个快照到达前只显示加载态', async () => {
    render(<AccessSection t={t} />)
    expect(screen.getByTestId('access-section').textContent).toBe(en['access.loading'])
    await screen.findByTestId('access-toggle')
  })

  it('拉取失败时显示 store 错误并停留在加载态', async () => {
    route = () => replies.fail('连接被拒绝')
    render(<AccessSection t={t} />)
    expect((await screen.findByTestId('access-error')).textContent).toContain('连接被拒绝')
    expect(screen.getByTestId('access-section').textContent).toContain(en['access.loading'])
  })

  it('面板顶部渲染 status.error 与 status.warnings', async () => {
    route = () => replies.ok(statusPayload({ error: '监听端口被占用', warnings: ['地址会随网卡变化', '仅建议在可信网络使用'] }))
    render(<AccessSection t={t} />)
    expect((await screen.findByTestId('access-state-error')).textContent).toBe('监听端口被占用')
    const lines = screen.getByTestId('access-warning').querySelectorAll('li')
    expect(Array.from(lines).map(line => line.textContent)).toEqual(['地址会随网卡变化', '仅建议在可信网络使用'])
    expect(screen.getByTestId('access-page-hint').textContent).toBe(en['access.page.hint'])
  })

  it('局域网关闭时只留开关这一行', async () => {
    route = () => replies.ok(lanOff())
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-toggle')
    expect(lanSwitch().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByTestId('access-lan-address')).toBeNull()
    expect(screen.queryByTestId('access-lan-draft')).toBeNull()
  })

  it('打开局域网开关提交固定认证参数', async () => {
    once(replies.ok(lanOff()), replies.ok(statusPayload()))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-toggle')
    fireEvent.click(lanSwitch())
    await waitFor(() => expect(sent.at(-1)?.body).toEqual({ enabled: true, authEnabled: true, scope: 'all' }))
    expect(sent.at(-1)?.http).toBe('POST')
    expect(sent.at(-1)?.url).toBe(BASE)
    await screen.findByTestId('access-lan-address')
  })

  it('关闭局域网开关只提交 enabled: false', async () => {
    once(replies.ok(statusPayload()), replies.ok(lanOff()))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-lan-address')
    fireEvent.click(lanSwitch())
    await waitFor(() => expect(sent.at(-1)?.body).toEqual({ enabled: false }))
    expect(sent.at(-1)?.http).toBe('POST')
    await waitFor(() => expect(screen.queryByTestId('access-lan-address')).toBeNull())
  })

  it('地址下拉给出回环、全网卡与推荐地址，改动只落草稿', async () => {
    once(replies.ok(statusPayload()), replies.ok(statusPayload({ listen: { address: '127.0.0.1', port: 3088 } })))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-lan-address')
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(Array.from(select.options).map(option => option.value)).toEqual(['127.0.0.1', '0.0.0.0', '192.168.1.5'])
    expect(select.options[0]?.textContent).toBe(`127.0.0.1（${en['access.lan.loopback']}）`)
    expect(select.options[1]?.textContent).toBe(`0.0.0.0（${en['access.listen.allInterfaces']}）`)
    expect(select.options[2]?.textContent).toBe(`192.168.1.5 · en0（${en['access.listen.recommended']}）`)
    fireEvent.change(select, { target: { value: '127.0.0.1' } })
    await screen.findByTestId('access-lan-draft')
    expect(getCalls(BASE, 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('access-lan-cancel'))
    await waitFor(() => expect(screen.queryByTestId('access-lan-draft')).toBeNull())
    expect(getCalls(BASE, 'POST')).toHaveLength(0)
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('192.168.1.5')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '127.0.0.1' } })
    fireEvent.click(await screen.findByTestId('access-lan-save'))
    await waitFor(() => expect(getCalls(BASE, 'POST')).toHaveLength(1))
    expect(getCalls(BASE, 'POST')[0]?.body).toEqual({ address: '127.0.0.1' })
    await waitFor(() => expect(screen.queryByTestId('access-lan-draft')).toBeNull())
  })

  it('保存失败保留草稿输入并给出错误', async () => {
    once(replies.ok(statusPayload()), replies.http(400))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-lan-address')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '127.0.0.1' } })
    fireEvent.click(await screen.findByTestId('access-lan-save'))
    await waitFor(() => expect(screen.getByTestId('access-error').textContent).toContain('请求失败'))
    expect(screen.getByTestId('access-lan-draft')).toBeTruthy()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('127.0.0.1')
  })

  it('隧道关闭时不展开任何字段，打开开关本身不发请求', async () => {
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-toggle')
    expect(screen.queryByTestId('access-tunnel-mode')).toBeNull()
    expect(screen.queryByTestId('access-tunnel-start')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: TUNNEL_SWITCH }))
    await screen.findByTestId('access-tunnel-mode')
    expect(screen.queryByTestId('access-tunnel-token')).toBeNull()
    expect(screen.queryByTestId('access-tunnel-stop')).toBeNull()
    expect(getCalls(TUNNEL, 'POST')).toHaveLength(0)
  })

  it('切到具名模式后按占位与主机名引导，缺 Token 时不提交', async () => {
    route = () => replies.ok(statusPayload({ tunnel: tunnelPayload() }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-toggle')
    fireEvent.click(screen.getByRole('switch', { name: TUNNEL_SWITCH }))
    await screen.findByTestId('access-tunnel-mode')
    expect(screen.queryByTestId('access-tunnel-token')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: en['access.tunnel.mode.token'] }))
    const tokenField = await screen.findByTestId('access-tunnel-token')
    expect(screen.getByTestId('access-tunnel-hostname')).toBeTruthy()
    expect(tokenField.getAttribute('placeholder')).toBe(en['access.tunnel.tokenPlaceholder'])
    expect(screen.queryByTestId('access-tunnel-hint')).toBeNull()
    expect((screen.getByTestId('access-tunnel-save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('access-tunnel-save'))
    expect(getCalls(TUNNEL, 'POST')).toHaveLength(0)
    fireEvent.change(tokenField, { target: { value: 'cf-new' } })
    expect(screen.getByTestId('access-tunnel-hint').textContent).toBe(en['access.tunnel.hostnameRequired'])
    fireEvent.change(screen.getByTestId('access-tunnel-hostname'), { target: { value: 'dsh.example.com' } })
    expect(screen.queryByTestId('access-tunnel-hint')).toBeNull()
    expect((screen.getByTestId('access-tunnel-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('quick 模式启动隧道：请求体只带模式', async () => {
    once(
      replies.ok(statusPayload({ tunnel: tunnelPayload() })),
      replies.ok(statusPayload({ tunnel: tunnelPayload({ enabled: true, state: 'running', hostname: 'bold-fox-abc.trycloudflare.com' }) })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-toggle')
    fireEvent.click(screen.getByRole('switch', { name: TUNNEL_SWITCH }))
    fireEvent.click(await screen.findByTestId('access-tunnel-start'))
    await waitFor(() => expect(getCalls(TUNNEL, 'POST')).toHaveLength(1))
    expect(getCalls(TUNNEL, 'POST')[0]?.body).toEqual({ mode: 'quick' })
    await waitFor(() => expect(screen.getByTestId('access-tunnel-state').textContent).toBe(en['access.tunnel.state.running']))
  })

  it('具名模式沿用已保存 Token，只提交改动过的主机名', async () => {
    once(
      replies.ok(statusPayload({ tunnel: tunnelPayload({ enabled: true, mode: 'token', token: 'cf-saved', hostname: 'dsh.example.com' }) })),
      replies.ok(statusPayload({ tunnel: tunnelPayload({ enabled: true, mode: 'token', token: 'cf-saved', hostname: 'new.example.com' }) })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-hostname')
    const token = screen.getByTestId('access-tunnel-token') as HTMLInputElement
    expect(token.value).toBe('cf-saved')
    expect(token.getAttribute('placeholder'), '已有 Token 时占位提示沿用').toBe(en['access.tunnel.tokenSaved'])
    fireEvent.change(token, { target: { value: '' } })
    expect(token.value, '清空 Token 输入必须回落到已保存凭据').toBe('cf-saved')
    fireEvent.change(screen.getByTestId('access-tunnel-hostname'), { target: { value: 'new.example.com' } })
    fireEvent.click(await screen.findByTestId('access-tunnel-save'))
    await waitFor(() => expect(getCalls(TUNNEL, 'POST')).toHaveLength(1))
    expect(getCalls(TUNNEL, 'POST')[0]?.body).toEqual({ mode: 'token', token: 'cf-saved', hostname: 'new.example.com' })
  })

  it('取消隧道草稿不发任何请求', async () => {
    once(replies.ok(statusPayload({ tunnel: tunnelPayload({ enabled: true, mode: 'token', token: 'cf-saved', hostname: 'dsh.example.com' }) })))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-hostname')
    fireEvent.change(screen.getByTestId('access-tunnel-hostname'), { target: { value: 'other.example.com' } })
    fireEvent.click(await screen.findByTestId('access-tunnel-cancel'))
    await waitFor(() => expect(screen.queryByTestId('access-tunnel-cancel')).toBeNull())
    expect(getCalls(TUNNEL, 'POST')).toHaveLength(0)
    expect(getCalls(TUNNEL, 'DELETE')).toHaveLength(0)
  })

  it('运行中的隧道停止走 DELETE', async () => {
    once(
      replies.ok(statusPayload({ tunnel: tunnelPayload({ enabled: true, state: 'running', hostname: 'bold-fox-abc.trycloudflare.com' }) })),
      replies.ok(statusPayload({ tunnel: tunnelPayload({ enabled: true, state: 'stopped' }) })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-stop')
    expect((screen.getByTestId('access-tunnel-start') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('access-tunnel-stop'))
    await waitFor(() => expect(getCalls(TUNNEL, 'DELETE')).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('access-tunnel-state').textContent).toBe(en['access.tunnel.state.stopped']))
  })

  it('运行中的隧道只显示带绿点的状态，不再显示已就绪进度', async () => {
    route = () => replies.ok(statusPayload({
      tunnel: tunnelPayload({ enabled: true, state: 'running', progress: { stage: 'ready' } }),
    }))
    render(<AccessSection t={t} />)
    const state = await screen.findByTestId('access-tunnel-state')
    expect(state.textContent).toBe(en['access.tunnel.state.running'])
    expect(state.firstElementChild?.getAttribute('data-state')).toBe('done')
    expect(screen.queryByTestId('access-tunnel-progress')).toBeNull()
    expect(screen.queryByText(en['access.tunnel.progress.ready'])).toBeNull()
  })

  it('下载阶段只显示带百分比的下载进度，不叠加隧道启动中', async () => {
    route = () => replies.ok(statusPayload({
      tunnel: tunnelPayload({ enabled: true, state: 'starting', progress: { stage: 'download', url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz', received: 3_200_000, total: 6_400_000 } }),
    }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-progress')
    expect(screen.getByTestId('access-tunnel-progress-line').textContent).toBe(`${en['access.tunnel.progress.download']} 50%`)
    expect(screen.queryByText(en['access.tunnel.state.starting'])).toBeNull()
    expect(screen.queryByTestId('state-dot')).toBeNull()
    expect(screen.getByTestId('access-tunnel-progress-bar').querySelector('div')?.getAttribute('style')).toContain('width: 50%')
  })

  it('非下载阶段只显示单一启动文案，不展示下载进度条', async () => {
    route = () => replies.ok(statusPayload({
      tunnel: tunnelPayload({ enabled: true, state: 'starting', progress: { stage: 'spawn', received: 6_400_000, total: 6_400_000 } }),
    }))
    render(<AccessSection t={t} />)
    const state = await screen.findByTestId('access-tunnel-state')
    expect(state.textContent).toBe(en['access.tunnel.state.starting'])
    expect(screen.getAllByText(en['access.tunnel.state.starting'])).toHaveLength(1)
    expect(screen.queryByTestId('access-tunnel-progress')).toBeNull()
    expect(screen.queryByTestId('access-tunnel-progress-bar')).toBeNull()
  })

  it('隧道失败时错误、重试与停止都可见', async () => {
    route = () => replies.ok(statusPayload({
      tunnel: tunnelPayload({ enabled: true, state: 'error', error: 'cloudflared 下载失败（已尝试：https://…）' }),
    }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-error')
    expect(screen.getByTestId('access-tunnel-error').textContent).toContain('cloudflared 下载失败')
    expect(screen.queryByTestId('state-dot')).toBeNull()
    expect(screen.getByTestId('access-tunnel-start').textContent).toBe(en['access.tunnel.retry'])
    expect((screen.getByTestId('access-tunnel-stop') as HTMLButtonElement).disabled).toBe(false)
  })

  it('没有配对码时提示开启监听，且不显示倒计时', async () => {
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-pairing')
    expect(screen.getByTestId('access-pairing-code').textContent).toBe(en['access.pairing.none'])
    expect(screen.queryByTestId('access-pairing-countdown')).toBeNull()
  })

  it('有配对码时显示码与剩余倒计时', async () => {
    route = () => replies.ok(statusPayload({ pairing: pairingPayload() }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-pairing-countdown')
    expect(screen.getByTestId('access-pairing-code').textContent).toBe('AB12CD34')
    const countdown = screen.getByTestId('access-pairing-countdown').textContent ?? ''
    expect(countdown.startsWith(`${en['access.pairing.remaining']} `)).toBe(true)
    expect(countdown).toMatch(/\d:\d{2}$/)
    expect(Array.from(screen.getByTestId('access-pairing').children, child => child.getAttribute('data-testid'))).toEqual(['access-pairing-countdown', 'access-pairing-code'])
    expect(screen.getByTestId('access-pairing-code').className).toContain('border-l-[0.5px]')
  })

  it('配对码过期后提示已过期并自动刷新一次', async () => {
    let expired = true
    route = () => replies.ok(statusPayload(expired ? { pairing: pairingPayload({ expiresAt: Date.now() - 60_000 }) } : {}))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-pairing-countdown')
    expect(screen.getByTestId('access-pairing-countdown').textContent).toBe(en['access.pairing.expired'])
    expired = false
    await waitFor(() => expect(getCalls(BASE, 'GET').length).toBeGreaterThanOrEqual(2))
  })

  it('只用临时码配对也能撤销所有设备授权，不必先生成永久码', async () => {
    once(
      replies.ok(statusPayload({ auth: authPayload({ hasToken: false }), pairing: pairingPayload() })),
      replies.ok(statusPayload({ auth: authPayload({ hasToken: false }), pairing: pairingPayload({ code: 'WX67YZ89' }) })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-pairing-code')
    const revoke = screen.getByTestId('access-token-revoke')
    expect(revoke.textContent).toBe(en['access.token.revoke'])
    expect((revoke as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('access-permanent-value')).toBeNull()
    fireEvent.click(revoke)
    await waitFor(() => expect(getCalls(TOKEN, 'DELETE')).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('access-pairing-code').textContent).toBe('WX67YZ89'))
  })

  it('永久码未签发时给生成按钮，生成后当次明文可见并走 POST /access/token', async () => {
    once(replies.ok(statusPayload()), replies.ok(statusPayload({ auth: authPayload({ token: PERMANENT }) })))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-token-rotate')
    expect(screen.getByTestId('access-token-rotate').textContent).toBe(en['access.token.generate'])
    expect(screen.queryByTestId('access-permanent-value')).toBeNull()
    expect(screen.queryByTestId('access-permanent-reveal')).toBeNull()
    expect(screen.getByTestId('access-token-revoke').textContent).toBe(en['access.token.revoke'])
    fireEvent.click(screen.getByTestId('access-token-rotate'))
    await waitFor(() => expect(getCalls(TOKEN, 'POST')).toHaveLength(1))
    await screen.findByTestId('access-permanent-value')
    expect(screen.getByTestId('access-permanent-value').textContent).toBe(PERMANENT)
    fireEvent.click(screen.getByTestId('access-permanent-reveal'))
    await waitFor(() => expect(screen.getByTestId('access-permanent-value').textContent).toBe(MASKED))
  })

  it('永久码默认掩码、点显示才出明文，作废走 DELETE', async () => {
    once(
      replies.ok(statusPayload({ auth: authPayload({ token: PERMANENT }) })),
      replies.ok(statusPayload({ auth: authPayload() })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-permanent-value')
    expect(screen.getByTestId('access-permanent-value').textContent).toBe(MASKED)
    const reveal = screen.getByTestId('access-permanent-reveal')
    expect(reveal.textContent).toBe(en['access.token.reveal'])
    expect(reveal.getAttribute('aria-pressed')).toBe('false')
    expect(Array.from(screen.getByTestId('access-permanent').children, child => child.getAttribute('data-testid'))).toEqual(['access-permanent-reveal', 'access-permanent-value'])
    expect(screen.getByTestId('access-permanent-value').className).toContain('border-l-[0.5px]')
    fireEvent.click(reveal)
    await waitFor(() => expect(screen.getByTestId('access-permanent-value').textContent).toBe(PERMANENT))
    const hide = screen.getByTestId('access-permanent-reveal')
    expect(hide.textContent).toBe(en['access.token.hide'])
    expect(hide.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(hide)
    await waitFor(() => expect(screen.getByTestId('access-permanent-value').textContent).toBe(MASKED))
    fireEvent.click(screen.getByTestId('access-token-revoke'))
    await waitFor(() => expect(getCalls(TOKEN, 'DELETE')).toHaveLength(1))
    await screen.findByTestId('access-token-rotate')
  })

  it('面板不再渲染二维码、隧道事件、最近事件与认证配置', async () => {
    route = () => replies.ok(statusPayload({
      qr: 'data:image/png;base64,QUJD',
      pairing: pairingPayload({ qr: 'data:image/png;base64,QUJD' }),
      tunnel: tunnelPayload({
        enabled: true,
        state: 'running',
        hostname: 'bold-fox-abc.trycloudflare.com',
        qr: 'data:image/png;base64,QUJD',
        events: [{ seq: 1, ts: '2026-10-06T00:00:01.000Z', kind: 'state', line: '公网隧道已就绪' }],
      }),
      events: [{ seq: 1, ts: '2026-10-06T00:00:00.000Z', kind: 'state', line: '入站暴露已监听 192.168.1.5:3088' }],
    }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-pairing-code')
    expect(document.querySelector('img')).toBeNull()
    for (const id of REMOVED)
      expect(screen.queryByTestId(id), `不应再渲染 ${id}`).toBeNull()
  })
})
