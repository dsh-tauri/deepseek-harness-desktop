// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import { SshSection } from './ssh-section'

const baseURL = '/api/tauri/ssh'

vi.mock('dsh-tauri-ui/client', async () => (await import('../test-utils/ui-mock')).uiMock)

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

function bootWire(options: { enabled?: boolean } = {}) {
  let enabled = options.enabled ?? false
  answer((call) => {
    if (call.url === `${baseURL}/settings` && call.http === 'GET')
      return replies.ok({ enabled })
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

describe('sshSection', () => {
  it('未启用时只渲染 Hero（图标 + 描述 + 开启按钮），不渲染 Tabs 内容', async () => {
    bootWire()
    render(<SshSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('ssh-hero')).toBeTruthy())
    expect(screen.getByText('t:hero.title')).toBeTruthy()
    expect(screen.getByText('t:hero.desc')).toBeTruthy()
    expect(screen.getByTestId('ssh-enable').textContent).toBe('t:hero.enable')
    expect(screen.queryByTestId('ssh-tabs')).toBeNull()
    expect(screen.queryByText('t:tabs.machines')).toBeNull()
  })

  it('点击开启：settings.set 落定后原位切换到 Tabs（SSH 机器 / 同步到远端）', async () => {
    bootWire()
    render(<SshSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('ssh-enable')).toBeTruthy())

    fireEvent.click(screen.getByTestId('ssh-enable'))
    await waitFor(() => expect(screen.getByTestId('ssh-tabs')).toBeTruthy())
    expect(sent.some(call => call.url === `${baseURL}/settings` && call.http === 'POST')).toBe(true)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['t:tabs.machines', 't:tabs.sync'])
    expect(screen.queryByTestId('ssh-hero')).toBeNull()
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('t:tabs.machines')
  })

  it('点击禁用：保存关闭开关后回到 Hero 并卸载已访问的面板', async () => {
    bootWire({ enabled: true })
    render(<SshSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('ssh-tabs')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 't:tabs.sync' }))

    const button = screen.getByRole('button', { name: 't:disable' })
    expect(screen.getByTestId('ssh-tabs').contains(button)).toBe(true)
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByTestId('ssh-enable').textContent).toBe('t:hero.enable'))
    expect(sent.filter(call => call.url === `${baseURL}/settings` && call.http === 'POST').map(call => call.body)).toEqual([{ enabled: false }])
    expect(store.machines.enabled).toBe(false)
    expect(screen.queryByTestId('ssh-tabs')).toBeNull()
    expect(screen.queryAllByRole('tabpanel', { hidden: true })).toEqual([])
  })

  it('已启用：Tabs 默认停在「SSH 机器」，切换后渲染同步面板且已访问面板保持挂载', async () => {
    bootWire({ enabled: true })
    render(<SshSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('ssh-tabs')).toBeTruthy())

    const machinesPanel = document.getElementById('dsh-tauri-ssh-tabs-machines-panel')
    expect(machinesPanel?.hasAttribute('hidden')).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: 't:tabs.sync' }))
    await waitFor(() => {
      expect(document.getElementById('dsh-tauri-ssh-tabs-sync-panel')?.hasAttribute('hidden')).toBe(false)
    })
    expect(document.getElementById('dsh-tauri-ssh-tabs-machines-panel')?.hasAttribute('hidden')).toBe(true)
  })

  it('壳层 deep link：分区匹配时落到指定标签页，别的分区不动', async () => {
    bootWire({ enabled: true })
    render(<SshSection t={t as never} />)
    await waitFor(() => expect(screen.getByTestId('ssh-tabs')).toBeTruthy())

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsh://settings:open', section: 'dsh-tauri-ssh-sync', tab: 'sync' },
      source: window,
    }))
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('t:tabs.machines')

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsh://settings:open', section: 'dsh-tauri-ssh', tab: 'sync' },
      source: window,
    }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { selected: true }).textContent).toBe('t:tabs.sync')
    })
  })

  it('读取开关失败（插件未加载）：Hero 呈现本地化的不可用提示而非原生解析异常', async () => {
    answer(() => replies.http(405))
    render(<SshSection t={t as never} />)

    await waitFor(() => expect(screen.getByTestId('ssh-hero-error')).toBeTruthy())
    expect(screen.getByTestId('ssh-hero-error').textContent).toBe('t:error.unavailable')
  })
})
