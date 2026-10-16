// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import { RemoteSection } from './remote-section'

const baseURL = '/api/tauri/remote'

vi.mock('dsh-tauri-ui/client', async () => (await import('../test-utils/ui-mock')).uiMock)

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

function accessPayload(): Record<string, unknown> {
  return {
    enabled: true,
    listening: false,
    state: 'stopped',
    listen: { address: '127.0.0.1', port: 3088 },
    port: 0,
    addresses: [],
    auth: { enabled: false, scope: 'public_only' },
    tunnel: { enabled: false, mode: 'quick', hostname: null, state: 'stopped', events: [] },
    events: [],
  }
}

function bootWire(options: { enabled?: boolean, warning?: string } = {}) {
  let enabled = options.enabled ?? false
  answer((call) => {
    if (call.url === `${baseURL}/settings` && call.http === 'GET') {
      return replies.ok({
        enabled,
        ...options.warning === undefined ? {} : { warning: options.warning },
      })
    }
    if (call.url === `${baseURL}/settings`) {
      enabled = call.body.enabled === true
      return replies.ok({ enabled })
    }
    if (call.url === `${baseURL}/session/role`)
      return replies.ok({ remote: false })
    if (call.url === `${baseURL}/access`)
      return replies.ok(accessPayload())
    return replies.ok({ items: [], discovered: [] })
  })
}

const t = (key: string) => `t:${key}`

beforeEach(() => {
  resetWire()
  store.machines.reset()
  store.access.reset()
})

afterEach(() => {
  cleanup()
})

describe('remoteSection', () => {
  it('整页 Hero 与全局禁用按钮已移除：三个 Tabs 始终渲染', async () => {
    bootWire()
    render(<RemoteSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())
    const tabs = within(screen.getByTestId('remote-tabs')).getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['t:tabs.access', 't:tabs.machines', 't:tabs.sync'])
    expect(within(screen.getByTestId('remote-tabs')).getByRole('tab', { selected: true }).textContent).toBe('t:tabs.access')
    expect(screen.queryByTestId('remote-hero')).toBeNull()
    expect(screen.queryByTestId('remote-enable')).toBeNull()
    expect(screen.queryByTestId('remote-hero-error')).toBeNull()
    expect(screen.queryByRole('button', { name: 't:disable' })).toBeNull()
  })

  it('切换标签页渲染对应面板：已访问面板保持挂载，未访问面板不挂载', async () => {
    bootWire({ enabled: true })
    render(<RemoteSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())

    expect(document.getElementById('dsh-tauri-remote-tabs-access-panel')?.hasAttribute('hidden')).toBe(false)
    expect(document.getElementById('dsh-tauri-remote-tabs-sync-panel')).toBeNull()

    fireEvent.click(within(screen.getByTestId('remote-tabs')).getByRole('tab', { name: 't:tabs.sync' }))
    await waitFor(() => {
      expect(document.getElementById('dsh-tauri-remote-tabs-sync-panel')?.hasAttribute('hidden')).toBe(false)
    })
    expect(document.getElementById('dsh-tauri-remote-tabs-access-panel')?.hasAttribute('hidden')).toBe(true)
  })

  it('开关搬进「连接到 SSH 服务器」Tab：关闭时给提示且不拉机器列表，打开后写设置并拉取', async () => {
    bootWire()
    render(<RemoteSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())

    fireEvent.click(within(screen.getByTestId('remote-tabs')).getByRole('tab', { name: 't:tabs.machines' }))
    const toggle = await screen.findByTestId('machines-enable-toggle')
    expect(screen.getByTestId('machines-disabled')).toBeTruthy()
    expect(sent.some(call => call.url === `${baseURL}/machines` && call.http === 'GET')).toBe(false)

    fireEvent.click(within(toggle).getByRole('switch'))
    await waitFor(() => expect(sent.some(call => call.url === `${baseURL}/settings` && call.http === 'POST')).toBe(true))
    expect(sent.find(call => call.url === `${baseURL}/settings` && call.http === 'POST')?.body).toEqual({ enabled: true })
    await waitFor(() => expect(store.machines.enabled).toBe(true))
    await waitFor(() => expect(sent.some(call => call.url === `${baseURL}/machines` && call.http === 'GET')).toBe(true))
    expect(screen.queryByTestId('machines-disabled')).toBeNull()
  })

  it('settings 读取失败不再挡住整个面板：Tabs 仍可选，开关落到关闭态', async () => {
    answer(() => replies.http(405))
    render(<RemoteSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())
    await waitFor(() => expect(store.machines.enabled).toBe(false))
    expect(screen.queryByTestId('remote-hero')).toBeNull()
  })

  it('迁移失败：settings 读接口带回的告警在面板上可见，且未启用时也能看到', async () => {
    bootWire({ warning: 'machines.json 不是合法 JSON，已跳过' })
    render(<RemoteSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('remote-migration-warning')).toBeTruthy())
    expect(screen.getByTestId('remote-migration-warning').textContent).toBe('t:migration.warningmachines.json 不是合法 JSON，已跳过')
    expect(screen.getByRole('alert').textContent).toContain('不是合法 JSON')
    expect(screen.getByTestId('remote-tabs')).toBeTruthy()
  })

  it('迁移成功：settings 读接口不带 warning 时面板不渲染告警', async () => {
    bootWire({ enabled: true })
    render(<RemoteSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())
    expect(screen.queryByTestId('remote-migration-warning')).toBeNull()
  })

  it('壳层 deep link：分区匹配时落到指定标签页，别的分区不动', async () => {
    bootWire({ enabled: true })
    render(<RemoteSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsh://settings:open', section: 'dsh-tauri-remote-sync', tab: 'sync' },
      source: window,
    }))
    expect(within(screen.getByTestId('remote-tabs')).getByRole('tab', { selected: true }).textContent).toBe('t:tabs.access')

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsh://settings:open', section: 'dsh-tauri-remote', tab: 'sync' },
      source: window,
    }))
    await waitFor(() => {
      expect(within(screen.getByTestId('remote-tabs')).getByRole('tab', { selected: true }).textContent).toBe('t:tabs.sync')
    })
  })
})
