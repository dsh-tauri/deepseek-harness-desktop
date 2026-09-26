// @vitest-environment jsdom
import type { FetchFn } from '../store/index'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachinesStore } from '../store/index'
import { SshSection } from './ssh-section'

// dsh-tauri-ui/client 的 dist bundle 以 ModuleLoader 工厂包裹，脱离宿主加载器无法在
// node 求值：通用控件用最小替身（本套用例只关心 Hero / Tabs 的取舍与定位），
// listenParent 取真实源实现，好让 deep link 走一遍真实的消息过滤。
vi.mock('dsh-tauri-ui/client', async () => {
  const mod = await import('../../../../dsh-tauri-ui/src/client/utils/cssr.ts')
  const React = await import('react')
  const h = React.createElement
  const passthrough = (props: { children?: unknown }) => h('div', null, props.children as never)
  return {
    cssr: mod.cssr,
    Button: ({ variant: _variant, size: _size, onPress, ...rest }: { variant?: unknown, size?: unknown, onPress?: () => void } & Record<string, unknown>) =>
      h('button', { type: 'button', ...rest, onClick: onPress ?? rest.onClick } as never, rest.children as never),
    Globe: () => null,
    Icon: () => null,
    Input: () => null,
    Modal: passthrough,
    Pill: passthrough,
    StateDot: () => null,
    SegmentedControl: (props: { options: Array<{ value: string, label: string }>, value: string, onChange: (next: string) => void, id?: string }) =>
      h('div', { role: 'tablist' }, props.options.map(option =>
        h('button', {
          'key': option.value,
          'type': 'button',
          'role': 'tab',
          'aria-selected': option.value === props.value,
          'onClick': () => props.onChange(option.value),
        }, option.label))),
  }
})

vi.mock('dsh-tauri/client', async () => {
  const mod = await import('../../../../dsh-tauri/src/client/service/listen-parent.ts')
  return { listenParent: mod.listenParent }
})

/** A store whose /api-ssh answers the enable flow (off by default). */
function bootStore(options: { enabled?: boolean } = {}) {
  let enabled = options.enabled ?? false
  const fetchFn = vi.fn<FetchFn>(async (_url, init) => {
    const request = JSON.parse(String(init.body)) as { method: string }
    if (request.method === 'settings.get')
      return { json: async () => ({ ok: true, value: { enabled } }) } as unknown as Response
    if (request.method === 'settings.set') {
      enabled = true
      return { json: async () => ({ ok: true, value: { enabled } }) } as unknown as Response
    }
    if (request.method === 'session.role')
      return { json: async () => ({ ok: true, value: { remote: false } }) } as unknown as Response
    return { json: async () => ({ ok: true, value: { enabled, items: [], discovered: [] } }) } as unknown as Response
  })
  return { store: new MachinesStore(fetchFn), fetchFn }
}

/** The bound dictionary lookup (key is the text, as elsewhere in this package). */
const t = (key: string) => `t:${key}`

afterEach(() => {
  cleanup()
})

describe('sshSection', () => {
  it('未启用时只渲染 Hero（图标 + 描述 + 开启按钮），不渲染 Tabs 内容', async () => {
    const { store } = bootStore()
    render(<SshSection t={t as never} store={store} />)

    await waitFor(() => expect(screen.getByTestId('ssh-hero')).toBeTruthy())
    expect(screen.getByText('t:hero.title')).toBeTruthy()
    expect(screen.getByText('t:hero.desc')).toBeTruthy()
    expect(screen.getByTestId('ssh-enable').textContent).toBe('t:hero.enable')
    expect(screen.queryByTestId('ssh-tabs')).toBeNull()
    expect(screen.queryByText('t:tabs.machines')).toBeNull()
  })

  it('点击开启：settings.set 落定后原位切换到 Tabs（SSH 机器 / 同步到远端）', async () => {
    const { store, fetchFn } = bootStore()
    render(<SshSection t={t as never} store={store} />)
    await waitFor(() => expect(screen.getByTestId('ssh-enable')).toBeTruthy())

    fireEvent.click(screen.getByTestId('ssh-enable'))
    await waitFor(() => expect(screen.getByTestId('ssh-tabs')).toBeTruthy())
    expect(fetchFn.mock.calls.some(([, init]) => String(init?.body).includes('"settings.set"'))).toBe(true)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['t:tabs.machines', 't:tabs.sync'])
    expect(screen.queryByTestId('ssh-hero')).toBeNull()
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('t:tabs.machines')
  })

  it('已启用：Tabs 默认停在「SSH 机器」，切换后渲染同步面板且已访问面板保持挂载', async () => {
    const { store } = bootStore({ enabled: true })
    render(<SshSection t={t as never} store={store} />)
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
    const { store } = bootStore({ enabled: true })
    render(<SshSection t={t as never} store={store} />)
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
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false, status: 405, json: async () => ({}) }) as unknown as Response)
    const store = new MachinesStore(fetchFn)
    render(<SshSection t={t as never} store={store} />)

    await waitFor(() => expect(screen.getByTestId('ssh-hero-error')).toBeTruthy())
    expect(screen.getByTestId('ssh-hero-error').textContent).toBe('t:error.unavailable')
  })
})
