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

vi.mock('dsh-tauri-ui/client', async () => (await import('../test-utils/ui-mock')).uiMock)
vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as (key: RemoteKey) => string

const BASE = '/api/desktop/dsh-tauri-remote/access'

function tunnelPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: false, mode: 'quick', hostname: null, state: 'stopped', events: [], ...overrides }
}

function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    state: 'listening',
    listening: true,
    listen: { address: '192.168.1.5', port: 3088 },
    port: 3088,
    auth: { enabled: false, scope: 'public_only', hasPassword: false, hasToken: true },
    addresses: [{ address: '192.168.1.5', family: 'ipv4', interface: 'en0', scope: 'private', score: 120, recommended: true }],
    recommended: '192.168.1.5',
    link: 'http://192.168.1.5:3088/?auth=tok',
    maskLink: 'http://192.168.1.5:3088/?auth=***',
    qr: 'data:image/png;base64,QUJD',
    tunnel: tunnelPayload(),
    localPort: 3080,
    events: [{ seq: 1, ts: '2026-10-06T00:00:00.000Z', kind: 'state', line: '入站暴露已监听 192.168.1.5:3088' }],
    ...overrides,
  }
}

let queued: WireReply[] = []
let route: (call: WireCall) => WireReply = () => replies.ok(statusPayload())

function once(...next: WireReply[]): void {
  queued.push(...next)
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
})

describe('接入面板', () => {
  it('渲染监听状态、访问链接与二维码', async () => {
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-link')
    expect(screen.getByTestId('access-link').textContent).toBe('http://192.168.1.5:3088/?auth=tok')
    expect(screen.getByTestId('access-link-qr')).toBeTruthy()
    expect(screen.queryByTestId('access-mask-link')).toBeNull()
    expect(screen.queryByTestId('access-state-error')).toBeNull()
  })

  it('非回环来源只显示掩码链接，不给二维码', async () => {
    route = () => replies.ok(statusPayload({ link: undefined, qr: undefined }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-mask-link')
    expect(screen.queryByTestId('access-link')).toBeNull()
    expect(screen.queryByTestId('access-link-qr')).toBeNull()
  })

  it('开关直接以回包更新面板状态', async () => {
    once(
      replies.ok(statusPayload()),
      replies.ok(statusPayload({ enabled: false, listening: false, state: 'stopped', link: undefined, qr: undefined, maskLink: undefined })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-toggle')
    fireEvent.click(screen.getByTestId('access-toggle'))
    await waitFor(() => {
      expect(sent.at(-1)?.url).toBe(BASE)
      expect(sent.at(-1)?.body).toEqual({ enabled: false })
    })
    await waitFor(() => {
      expect(store.access.snapshot?.enabled).toBe(false)
    })
  })

  it('quick 模式启动隧道：请求体只带模式，回包里的公网地址与事件进入面板', async () => {
    once(
      replies.ok(statusPayload()),
      replies.ok(statusPayload({
        tunnel: tunnelPayload({
          enabled: true,
          state: 'running',
          hostname: 'bold-fox-abc.trycloudflare.com',
          url: 'https://bold-fox-abc.trycloudflare.com',
          port: 3089,
          link: 'https://bold-fox-abc.trycloudflare.com/?auth=tok',
          events: [{ seq: 1, ts: '2026-10-06T00:00:01.000Z', kind: 'state', line: '公网隧道已就绪：https://bold-fox-abc.trycloudflare.com' }],
        }),
      })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-start')
    fireEvent.click(screen.getByTestId('access-tunnel-start'))
    await waitFor(() => {
      expect(sent.at(-1)?.url).toBe(`${BASE}/tunnel`)
      expect(sent.at(-1)?.body).toEqual({ mode: 'quick' })
    })
    await screen.findByTestId('access-tunnel-url')
    expect(screen.getByTestId('access-tunnel-url').textContent).toBe('https://bold-fox-abc.trycloudflare.com')
    expect(screen.getByTestId('access-tunnel-state').textContent).toBe(en['access.tunnel.state.running'])
    expect(screen.getByTestId('access-tunnel-ready').textContent).toContain('公网隧道已就绪')
  })

  it('具名模式：切到 token 模式后请求体带凭据与公开主机名', async () => {
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-start')
    fireEvent.click(screen.getByRole('tab', { name: en['access.tunnel.mode.token'] }))
    const password = screen.getByTestId('access-tunnel-token')
    const hostname = screen.getByTestId('access-tunnel-hostname')
    fireEvent.change(password, { target: { value: 'cf-token' } })
    fireEvent.change(hostname, { target: { value: 'dsh.example.com' } })
    fireEvent.click(screen.getByTestId('access-tunnel-start'))
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ mode: 'token', token: 'cf-token', hostname: 'dsh.example.com' })
    })
  })

  it('设置与清除访问密码都走 /access 的 password 字段', async () => {
    const base = { enabled: true, scope: 'public_only', hasToken: false }
    once(
      replies.ok(statusPayload({ auth: { ...base, hasPassword: false } })),
      replies.ok(statusPayload({ auth: { ...base, hasPassword: true } })),
      replies.ok(statusPayload({ auth: { ...base, hasPassword: false } })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-password-save')
    fireEvent.change(screen.getByPlaceholderText(en['access.auth.noPassword']), { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByTestId('access-password-save'))
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ password: 'hunter2' })
    })
    await screen.findByPlaceholderText(en['access.auth.hasPassword'])
    fireEvent.click(screen.getByTestId('access-password-clear'))
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ password: null })
    })
  })

  it('隧道启动失败时错误与停止按钮状态可见', async () => {
    once(
      replies.ok(statusPayload()),
      replies.ok(statusPayload({ tunnel: tunnelPayload({ enabled: true, state: 'error', error: 'cloudflared 下载失败（已尝试：https://…）' }) })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-start')
    fireEvent.click(screen.getByTestId('access-tunnel-start'))
    await screen.findByTestId('access-tunnel-error')
    expect(screen.getByTestId('access-tunnel-error').textContent).toContain('cloudflared 下载失败')
    expect((screen.getByTestId('access-tunnel-stop') as HTMLButtonElement).disabled).toBe(false)
  })
})
