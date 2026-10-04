// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { defineStore } from 'valtio-define'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigNetwork } from './network'

const mocks = vi.hoisted(() => ({ setting: {} as any, toast: vi.fn() }))
vi.mock('@/store', () => ({
  store: {
    get setting() {
      return mocks.setting
    },
  },
}))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function setup(saved = '', failure?: string) {
  const update = vi.fn(async ({ proxyUrl }: { proxyUrl: string }) => {
    if (failure)
      throw new Error(failure)
    mocks.setting.$patch({ proxy_url: proxyUrl })
  })
  mocks.setting = defineStore({ state: () => ({ proxy_url: saved }), actions: { update } })
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><ConfigNetwork /></QueryClientProvider>)
  return update
}

function enter(value: string) {
  fireEvent.change(screen.getByLabelText('network.proxy_url'), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'buttons.save' }))
}

describe('desktop proxy configuration', () => {
  it('shows the persisted address without writing during hydration', () => {
    const update = setup('http://127.0.0.1:7897/')
    expect((screen.getByLabelText('network.proxy_url') as HTMLInputElement).value).toBe('http://127.0.0.1:7897/')
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    expect(update).not.toHaveBeenCalled()
  })

  it.each(['http://127.0.0.1:7897', 'https://proxy.example:8443', 'socks5://localhost:1080', 'socks5h://[::1]:1080'])('saves %s as a partial native settings update', async (url) => {
    const update = setup()
    enter(` ${url} `)
    await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith({ proxyUrl: url }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('network.saved'))
    expect(mocks.setting.proxy_url).toBe(url)
  })

  it('clears an explicit proxy to restore inherited settings', async () => {
    const update = setup('http://127.0.0.1:7897/')
    enter('')
    await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith({ proxyUrl: '' }))
    await waitFor(() => expect(mocks.setting.proxy_url).toBe(''))
  })

  it.each(['localhost:7897', 'ftp://proxy.example', 'http:proxy.example', 'http://proxy.example:0', 'http://proxy.example/path', 'http://proxy.example?secret=value', 'http://proxy.example#x'])('rejects invalid address %s before IPC', async (url) => {
    const update = setup()
    enter(url)
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('network.invalid', { variant: 'danger' }))
    expect(update).not.toHaveBeenCalled()
    expect(mocks.setting.proxy_url).toBe('')
  })

  it('retains the edit and saved settings when native persistence fails', async () => {
    setup('http://localhost:7897/', 'disk write failed')
    enter('socks5h://localhost:1080')
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('network.save_failed', { variant: 'danger' }))
    expect(mocks.setting.proxy_url).toBe('http://localhost:7897/')
    expect((screen.getByLabelText('network.proxy_url') as HTMLInputElement).value).toBe('socks5h://localhost:1080')
  })

  it('reports native validation errors without displaying the supplied credentials', async () => {
    setup('', 'PROXY_INVALID: invalid URL')
    enter('http://user:secret@proxy.example:8080')
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('network.invalid', { variant: 'danger' }))
    expect((screen.getByLabelText('network.proxy_url') as HTMLInputElement).type).toBe('password')
  })
})
