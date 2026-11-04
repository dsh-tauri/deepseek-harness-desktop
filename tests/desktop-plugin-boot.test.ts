import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const script = readFileSync(new URL('../apps/desktop/src-tauri/src/desktop/plugin_boot.js.inc', import.meta.url), 'utf8')

interface BootNode { children: BootNode[], textContent: string }

function leaf(textContent: string): BootNode {
  return { children: [], textContent }
}

function bootCard(rows: string[]): BootNode {
  return { children: [leaf('HARNESS'), { children: rows.map(leaf), textContent: '' }], textContent: '' }
}

function setup(initial: BootNode | null) {
  let boot = initial
  let rerun: (() => void) | undefined
  const invoke = vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined)
  const timers = new Set<ReturnType<typeof setInterval>>()
  const sandbox: Record<string, unknown> = {
    __DSH_SHELL__: { window: 'main', guest: 'harness-1' },
    document: { querySelector: (selector: string) => selector === '[data-dsh-boot]' ? boot : null },
    MutationObserver: class {
      constructor(callback: () => void) { rerun = callback }
      observe() {}
      disconnect() {}
    },
    setInterval: (callback: () => void) => {
      const handle = setInterval(callback, 1000)
      timers.add(handle)
      return handle
    },
    clearInterval: (handle: ReturnType<typeof setInterval>) => {
      clearInterval(handle)
      timers.delete(handle)
    },
    console,
  }
  sandbox.window = {
    __TAURI_INTERNALS__: { invoke },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  runInNewContext(script, sandbox)
  return {
    invoke,
    timers,
    show: (next: BootNode | null) => { boot = next },
    evaluate: () => rerun?.(),
    payload: () => vi.mocked(invoke).mock.calls[0]?.[1],
  }
}

describe('harness boot failure watcher', () => {
  it('reports the official failure card once, keeping the plugin rows on their own lines', () => {
    const boot = setup(bootCard(['Failed to load plugins', 'dsh-tauri-kernel', 'web boot: 1 entry did not activate']))
    expect(boot.invoke).toHaveBeenCalledExactlyOnceWith('plugin:event|emit_to', {
      target: { kind: 'Window', label: 'main' },
      event: 'dsh://plugin-boot:failed',
      payload: { label: 'harness-1', detail: 'Failed to load plugins\ndsh-tauri-kernel\nweb boot: 1 entry did not activate' },
    })
    expect(boot.timers.size).toBe(0)
    boot.evaluate()
    expect(boot.invoke).toHaveBeenCalledOnce()
  })

  it('waits through the loading card and reports a failure that renders later', () => {
    const boot = setup(bootCard(['HARNESS', 'Loading plugins…']))
    expect(boot.invoke).not.toHaveBeenCalled()
    boot.show(bootCard(['Failed to load plugins', 'dsh-office-kit', 'dsh-office-kit: failed']))
    boot.evaluate()
    expect(boot.payload()).toEqual({
      target: { kind: 'Window', label: 'main' },
      event: 'dsh://plugin-boot:failed',
      payload: { label: 'harness-1', detail: 'Failed to load plugins\ndsh-office-kit\ndsh-office-kit: failed' },
    })
  })

  it('stops watching once the boot container is replaced by the application shell', () => {
    const boot = setup(bootCard(['HARNESS', 'Loading plugins…']))
    boot.show(null)
    boot.evaluate()
    expect(boot.invoke).not.toHaveBeenCalled()
    expect(boot.timers.size).toBe(0)
  })

  it('stays inert when the shell context or IPC carrier is missing', () => {
    const invoke = vi.fn()
    runInNewContext(script, { window: { __TAURI_INTERNALS__: { invoke } }, document: {}, console })
    expect(invoke).not.toHaveBeenCalled()
  })
})
