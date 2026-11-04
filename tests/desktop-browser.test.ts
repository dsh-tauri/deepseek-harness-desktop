import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const script = readFileSync(new URL('../apps/desktop/src-tauri/src/desktop/browser.js.inc', import.meta.url), 'utf8')

function setup() {
  let callback: ((event: { payload: { lease: string, url: string } }) => void) | undefined
  const invoke = vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
    if (command === 'plugin:event|listen')
      return 7
    if (command === 'acquire_browser_guest')
      return { lease: 'lease-a', partition: 'partition-a' }
  })
  const ipc = {
    invoke,
    transformCallback: vi.fn((handler: typeof callback) => {
      callback = handler
      return 42
    }),
    unregisterCallback: vi.fn(),
    metadata: { currentWebview: { label: 'harness-1' } },
  }
  const window = { __TAURI_INTERNALS__: ipc, dshDesktop: { existing: true } } as {
    __TAURI_INTERNALS__: typeof ipc
    dshDesktop: {
      existing: boolean
      protocolVersion: number
      deviceInfo: () => Promise<string>
      browser: {
        acquire: (workspace: string) => Promise<{ lease: string, partition: string }>
        release: (lease: string) => Promise<void>
        onOpenRequested: (lease: string, listener: (url: string) => void) => () => void
      }
    }
    dshDesktopBoot?: unknown
  }
  runInNewContext(script, { window, navigator: { userAgent: 'desktop-test' }, console })
  return { window, ipc, dispatch: (lease: string, url: string) => callback?.({ payload: { lease, url } }) }
}

describe('official desktop browser bridge', () => {
  it('exposes the versioned carrier before clients start and preserves existing capabilities', async () => {
    const { window } = setup()
    expect(window.dshDesktop.protocolVersion).toBe(1)
    expect(window.dshDesktop.existing).toBe(true)
    expect(await window.dshDesktop.deviceInfo()).toBe('desktop-test')
    expect(window.dshDesktopBoot).toBeUndefined()
  })

  it('subscribes to owner events before acquiring one guest and reuses the subscription', async () => {
    const { window, ipc } = setup()
    expect(await window.dshDesktop.browser.acquire('workspace-a')).toEqual({ lease: 'lease-a', partition: 'partition-a' })
    await window.dshDesktop.browser.acquire('workspace-b')
    expect(ipc.invoke.mock.calls).toEqual([
      ['plugin:event|listen', { event: 'dsh-browser-open-requested', target: { kind: 'Webview', label: 'harness-1' }, handler: 42 }],
      ['acquire_browser_guest', { workspace: 'workspace-a' }],
      ['acquire_browser_guest', { workspace: 'workspace-b' }],
    ])
  })

  it('delivers links only to subscribed leases and clears subscriptions after release', async () => {
    const { window, ipc, dispatch } = setup()
    const browser = window.dshDesktop.browser
    await browser.acquire('workspace-a')
    const listener = vi.fn()
    const removed = vi.fn()
    browser.onOpenRequested('lease-a', listener)
    const off = browser.onOpenRequested('lease-a', removed)
    off()
    dispatch('other', 'https://wrong.test/')
    dispatch('lease-a', 'https://example.test/')
    expect(listener.mock.calls).toEqual([['https://example.test/']])
    expect(removed).not.toHaveBeenCalled()
    await browser.release('lease-a')
    expect(ipc.invoke).toHaveBeenLastCalledWith('release_browser_guest', { lease: 'lease-a' })
    dispatch('lease-a', 'https://late.test/')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('propagates subscription errors without acquiring and permits retry', async () => {
    const { window, ipc } = setup()
    ipc.invoke.mockRejectedValueOnce(new Error('listen denied'))
    await expect(window.dshDesktop.browser.acquire('workspace-a')).rejects.toThrow('listen denied')
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(ipc.unregisterCallback).toHaveBeenCalledWith(42)
    await window.dshDesktop.browser.acquire('workspace-a')
    expect(ipc.invoke).toHaveBeenLastCalledWith('acquire_browser_guest', { workspace: 'workspace-a' })
  })
})
