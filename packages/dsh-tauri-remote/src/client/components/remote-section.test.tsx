// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import { RemoteSection } from './remote-section'

const baseURL = '/api/tauri/remote'

vi.mock('dsh-tauri-ui/client', async () => (await import('../test-utils/ui-mock')).uiMock)

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

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
    return replies.ok({ enabled, items: [], discovered: [] })
  })
}

const t = (key: string) => `t:${key}`

beforeEach(() => {
  resetWire()
  store.machines.reset()
})

afterEach(() => {
  cleanup()
})

describe('remoteSection', () => {
  it('未启用时只渲染 Hero（图标 + 描述 + 开启按钮），不渲染 Tabs 内容', async () => {
    bootWire()
    render(<RemoteSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('remote-hero')).toBeTruthy())
    expect(screen.getByText('t:hero.title')).toBeTruthy()
    expect(screen.getByText('t:hero.desc')).toBeTruthy()
    expect(screen.getByTestId('remote-enable').textContent).toBe('t:hero.enable')
    expect(screen.queryByTestId('remote-tabs')).toBeNull()
    expect(screen.queryByText('t:tabs.machines')).toBeNull()
  })

  it('点击开启：settings.set 落定后原位切换到 Tabs（SSH 机器 / 同步到远端）', async () => {
    bootWire()
    render(<RemoteSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('remote-enable')).toBeTruthy())

    fireEvent.click(screen.getByTestId('remote-enable'))
    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())
    expect(sent.some(call => call.url === `${baseURL}/settings` && call.http === 'POST')).toBe(true)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['t:tabs.machines', 't:tabs.sync'])
    expect(screen.queryByTestId('remote-hero')).toBeNull()
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('t:tabs.machines')
  })

  it('点击禁用：保存关闭开关后回到 Hero 并卸载已访问的面板', async () => {
    bootWire({ enabled: true })
    render(<RemoteSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 't:tabs.sync' }))

    const button = screen.getByRole('button', { name: 't:disable' })
    expect(screen.getByTestId('remote-tabs').contains(button)).toBe(true)
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByTestId('remote-enable').textContent).toBe('t:hero.enable'))
    expect(sent.filter(call => call.url === `${baseURL}/settings` && call.http === 'POST').map(call => call.body)).toEqual([{ enabled: false }])
    expect(store.machines.enabled).toBe(false)
    expect(screen.queryByTestId('remote-tabs')).toBeNull()
    expect(screen.queryAllByRole('tabpanel', { hidden: true })).toEqual([])
  })

  it('已启用：Tabs 默认停在「SSH 机器」，切换后渲染同步面板且已访问面板保持挂载', async () => {
    bootWire({ enabled: true })
    render(<RemoteSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())

    const machinesPanel = document.getElementById('dsh-tauri-remote-tabs-machines-panel')
    expect(machinesPanel?.hasAttribute('hidden')).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: 't:tabs.sync' }))
    await waitFor(() => {
      expect(document.getElementById('dsh-tauri-remote-tabs-sync-panel')?.hasAttribute('hidden')).toBe(false)
    })
    expect(document.getElementById('dsh-tauri-remote-tabs-machines-panel')?.hasAttribute('hidden')).toBe(true)
  })

  it('壳层 deep link：分区匹配时落到指定标签页，别的分区不动', async () => {
    bootWire({ enabled: true })
    render(<RemoteSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsh://settings:open', section: 'dsh-tauri-remote-sync', tab: 'sync' },
      source: window,
    }))
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('t:tabs.machines')

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsh://settings:open', section: 'dsh-tauri-remote', tab: 'sync' },
      source: window,
    }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { selected: true }).textContent).toBe('t:tabs.sync')
    })
  })

  it('读取开关失败（插件未加载）：Hero 呈现本地化的不可用提示而非原生解析异常', async () => {
    answer(() => replies.http(405))
    render(<RemoteSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('remote-hero-error')).toBeTruthy())
    expect(screen.getByTestId('remote-hero-error').textContent).toBe('t:error.unavailable')
  })

  it('迁移失败：settings 读接口带回的告警在面板上可见', async () => {
    bootWire({ enabled: true, warning: 'machines.json 不是合法 JSON，已跳过' })
    render(<RemoteSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('remote-migration-warning')).toBeTruthy())
    expect(screen.getByTestId('remote-migration-warning').textContent).toBe('t:migration.warningmachines.json 不是合法 JSON，已跳过')
    expect(screen.getByRole('alert').textContent).toContain('不是合法 JSON')
  })

  it('迁移失败：开关未开启时同样可见（不必先开启远端功能）', async () => {
    bootWire({ warning: 'machines.json 不是合法 JSON，已跳过' })
    render(<RemoteSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('remote-hero')).toBeTruthy())
    expect(screen.getByTestId('remote-migration-warning').textContent).toBe('t:migration.warningmachines.json 不是合法 JSON，已跳过')
    expect(screen.queryByTestId('remote-tabs')).toBeNull()
  })

  it('迁移成功：settings 读接口不带 warning 时面板不渲染告警', async () => {
    bootWire({ enabled: true })
    render(<RemoteSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('remote-tabs')).toBeTruthy())
    expect(screen.queryByTestId('remote-migration-warning')).toBeNull()
  })

  it('迁移成功且开关未开启：Hero 里也不渲染告警', async () => {
    bootWire()
    render(<RemoteSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('remote-hero')).toBeTruthy())
    expect(screen.queryByTestId('remote-migration-warning')).toBeNull()
  })
})
