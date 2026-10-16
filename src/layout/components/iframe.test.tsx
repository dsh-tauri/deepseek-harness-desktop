// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { store } from '@/store'
import { Iframe } from './iframe'

vi.mock('@choochmeque/tauri-plugin-notifications-api', () => ({}))
vi.mock('@overlastic/react', () => ({ useOverlay: () => vi.fn() }))
vi.mock('@/ui/dialog/config', () => ({ ConfigDialog: () => null }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/hooks/use-dsh-style', () => ({ useDshStyle: () => [{}, vi.fn()] }))
vi.mock('@/hooks/use-invoke-iframe', () => ({ useInvokeIframe: vi.fn() }))
vi.mock('@/hooks/use-notification-action', () => ({ useNotificationAction: vi.fn() }))
vi.mock('@/hooks/use-notification-clicked', () => ({ useNotificationClicked: vi.fn() }))
vi.mock('@/hooks/use-sync-visibility', () => ({ useSyncVisibility: vi.fn() }))
vi.mock('@/hooks/use-zoom-factor', () => ({ useZoomFactor: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mockIPC(() => undefined)
  Object.assign(store.harness, {
    serviceUrl: 'http://127.0.0.1:3081',
    frontendGeneration: 1,
    frontendBootHtml: null,
    status: 'ready',
    serviceHealthy: false,
    serviceRunning: true,
    busyAction: 'restart',
    iframeKey: 1077,
    iframeAliveKey: null,
    iframeLoaded: false,
    iframeError: false,
    iframeSrc: 'http://127.0.0.1:3081/?token=secret',
  })
})

afterEach(async () => {
  cleanup()
  store.harness.serviceHealthy = false
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('logs local mount and document states once per transition without adding waiting UI', async () => {
  const iframeRef = createRef<HTMLIFrameElement>()
  const view = render(<Iframe iframeRef={iframeRef} />)
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByTestId('dsh-shell-iframe')).toBeNull()
  expect(console.warn).toHaveBeenCalledWith('[Iframe] view', expect.objectContaining({
    branch: 'service-wait',
    serviceHealthy: false,
    serviceRunning: true,
    iframeKey: 1077,
    mounted: false,
  }))
  view.rerender(<Iframe iframeRef={iframeRef} />)
  expect(vi.mocked(console.warn).mock.calls.filter(([tag]) => tag === '[Iframe] view')).toHaveLength(1)

  await act(async () => {
    store.harness.serviceHealthy = true
  })
  const frame = screen.getByTestId<HTMLIFrameElement>('dsh-shell-iframe')
  expect(frame.style.visibility).toBe('visible')
  expect(screen.queryByRole('status')).toBeNull()
  expect(console.warn).toHaveBeenCalledWith('[Iframe] view', expect.objectContaining({ branch: 'document-wait', mounted: true, iframeAlive: false }))
  await act(async () => {
    frame.dispatchEvent(new Event('load'))
  })
  expect(console.warn).toHaveBeenCalledWith('[Iframe] view', expect.objectContaining({ branch: 'document-wait', iframeLoaded: true }))
  await act(async () => {
    store.harness.markIframeAlive()
  })
  expect(screen.getByTestId('dsh-shell-iframe')).toBe(frame)
  expect(console.warn).toHaveBeenCalledWith('[Iframe] view', expect.objectContaining({ branch: 'local-frame', iframeAlive: true }))
  await act(async () => {
    store.harness.markIframeError()
  })
  expect(screen.getByText('ui.iframe_error')).not.toBeNull()
  expect(frame.style.visibility).toBe('hidden')
  expect(console.warn).toHaveBeenCalledWith('[Iframe] view', expect.objectContaining({ branch: 'iframe-error', iframeError: true }))
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret')
})

it('preloads before health, hands live boot to the same frame, and falls back only once on failure', async () => {
  const src = 'http://127.0.0.1:3081/?dshDesktop&_dshPreload=7'
  let prepares = 0
  mockIPC((command) => {
    if (command === 'prepare_frontend_preload') {
      prepares++
      return src
    }
  })
  await act(async () => {
    render(<Iframe iframeRef={createRef()} />)
  })
  const frame = screen.getByTestId<HTMLIFrameElement>('dsh-shell-iframe')
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: 'http://127.0.0.1:3081', data: { type: 7 } }))
  })
  expect(frame.getAttribute('src')).toBe(src)
  expect(store.harness.serviceHealthy).toBe(false)
  expect(store.harness.iframeAlive).toBe(false)
  async function report(type: string, origin = 'http://127.0.0.1:3081', id = '7') {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin, data: { type, id } }))
    })
  }
  await report('dsh://frontend-preload:waiting', 'http://untrusted.test')
  await report('dsh://frontend-preload:waiting', undefined, '6')
  await act(async () => {
    store.harness.iframeSrc = 'http://127.0.0.1:3081/?dshDesktop&t=ready'
    store.harness.frontendBootHtml = '<!doctype html><html>authoritative health round</html>'
    store.harness.serviceHealthy = true
  })
  expect(screen.getByTestId('dsh-shell-iframe')).toBe(frame)
  expect(frame.getAttribute('src')).toBe(src)
  expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dsh://frontend-preload:boot' }), expect.anything())
  await report('dsh://frontend-preload:waiting')
  expect(post).toHaveBeenCalledWith({ source: 'dsh-desktop', type: 'dsh://frontend-preload:boot', id: '7', html: store.harness.frontendBootHtml }, 'http://127.0.0.1:3081')
  expect(store.harness.iframeAlive).toBe(false)
  await report('dsh://frontend-preload:applied')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000)
  })
  expect(screen.getByTestId('dsh-shell-iframe')).toBe(frame)
  await report('dsh://frontend-preload:failed')
  const fallback = screen.getByTestId<HTMLIFrameElement>('dsh-shell-iframe')
  expect(fallback).not.toBe(frame)
  expect(fallback.getAttribute('src')).toBe(store.harness.iframeSrc)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000)
  })
  expect(screen.getByTestId('dsh-shell-iframe')).toBe(fallback)
  expect(prepares).toBe(1)
})

it.each([
  ['template rejection', 'dsh://frontend-preload:failed'],
  ['timeout', null],
  ['missing health HTML', 'dsh://frontend-preload:waiting'],
  ['boot stall', 'dsh://plugin-boot:stalled'],
])('invalidates the old document on %s fallback so the replacement watchdog can report failure', async (_, type) => {
  mockIPC(command => command === 'prepare_frontend_preload' ? 'http://127.0.0.1:3081/?dshDesktop&_dshPreload=7' : undefined)
  await act(async () => {
    render(<Iframe iframeRef={createRef()} />)
  })
  const preload = screen.getByTestId<HTMLIFrameElement>('dsh-shell-iframe')
  await act(async () => {
    preload.dispatchEvent(new Event('load'))
    window.dispatchEvent(new MessageEvent('message', {
      source: preload.contentWindow,
      origin: 'http://127.0.0.1:3081',
      data: { type: 'dsh://sidebar:collapsed' },
    }))
  })
  expect(store.harness.iframeAlive).toBe(true)
  expect(store.harness.iframeLoaded).toBe(true)
  await act(async () => {
    store.harness.iframeSrc = 'http://127.0.0.1:3081/?dshDesktop&t=ready'
    store.harness.frontendBootHtml = type === 'dsh://frontend-preload:waiting' ? null : '<!doctype html><html>authoritative health round</html>'
    store.harness.serviceHealthy = true
  })
  await act(async () => {
    if (type === null) {
      await vi.advanceTimersByTimeAsync(8000)
    }
    else {
      window.dispatchEvent(new MessageEvent('message', {
        source: preload.contentWindow,
        origin: 'http://127.0.0.1:3081',
        data: { type, id: '7' },
      }))
    }
  })
  const fallback = screen.getByTestId<HTMLIFrameElement>('dsh-shell-iframe')
  expect(fallback).not.toBe(preload)
  expect(fallback.getAttribute('src')).toBe(store.harness.iframeSrc)
  expect(store.harness.iframeAlive).toBe(false)
  expect(store.harness.iframeLoaded).toBe(false)
  await act(async () => {
    fallback.dispatchEvent(new Event('load'))
  })
  expect(store.harness.iframeLoaded).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4999)
  })
  expect(screen.queryByText('ui.iframe_error')).toBeNull()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(screen.getByText('ui.iframe_error')).not.toBeNull()
  expect(fallback.style.visibility).toBe('hidden')
  expect(store.harness.serviceHealthy).toBe(true)
  expect(store.harness.serviceRunning).toBe(true)
})

it('diagnoses remote frame visibility across local health and error transitions without changing it', async () => {
  render(<Iframe iframeRef={createRef()} srcOverride="https://example.test/?token=secret" />)
  expect(screen.getByTestId('dsh-shell-iframe').getAttribute('src')).toBe('https://example.test/?token=secret')
  expect(screen.queryByRole('status')).toBeNull()
  expect(console.warn).toHaveBeenCalledWith('[Iframe] view', expect.objectContaining({ branch: 'remote-loading', remoteMode: true, serviceHealthy: false, mounted: true, iframeHidden: true }))
  const frame = screen.getByTestId<HTMLIFrameElement>('dsh-shell-iframe')
  await act(async () => {
    frame.dispatchEvent(new Event('load'))
  })
  expect(frame.style.visibility).toBe('visible')
  expect(console.warn).toHaveBeenCalledWith('[Iframe] view', expect.objectContaining({ branch: 'remote-frame', iframeHidden: false }))
  await act(async () => {
    store.harness.serviceHealthy = true
    store.harness.markIframeError()
  })
  expect(frame.style.visibility).toBe('hidden')
  expect(screen.queryByText('ui.iframe_error')).toBeNull()
  expect(console.warn).toHaveBeenLastCalledWith('[Iframe] view', expect.objectContaining({
    branch: 'remote-frame',
    serviceHealthy: true,
    iframeError: true,
    iframeHidden: true,
  }))
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret')
})
