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

function setup(initial: BootNode | null, invoke: (command: string, args?: unknown) => Promise<unknown> = async () => undefined) {
  let boot = initial
  let rerun: (() => void) | undefined
  const calls = vi.fn(invoke)
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
    __TAURI_INTERNALS__: { invoke: calls },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  runInNewContext(script, sandbox)
  return {
    invoke: calls,
    timers,
    show: (next: BootNode | null) => { boot = next },
    evaluate: () => rerun?.(),
    payload: () => vi.mocked(calls).mock.calls[0]?.[1],
  }
}

describe('harness boot failure watcher', () => {
  it('reports the official failure card once, keeping the plugin rows on their own lines', async () => {
    const boot = setup(bootCard(['Failed to load plugins', 'dsh-tauri-kernel', 'web boot: 1 entry did not activate']))
    expect(boot.invoke).toHaveBeenCalledExactlyOnceWith('plugin:event|emit_to', {
      target: { kind: 'Window', label: 'main' },
      event: 'dsh://plugin-boot:failed',
      payload: { label: 'harness-1', detail: 'Failed to load plugins\ndsh-tauri-kernel\nweb boot: 1 entry did not activate' },
    })
    await Promise.resolve()
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

  it('keeps watching after a failed report so the failure page is not lost', async () => {
    let failures = 1
    const boot = setup(
      bootCard(['Failed to load plugins', 'dsh-tauri-kernel']),
      async () => {
        if (failures > 0) {
          failures -= 1
          throw new Error('emit rejected')
        }
      },
    )
    await Promise.resolve()
    expect(boot.invoke).toHaveBeenCalledOnce()
    expect(boot.timers.size).toBe(1)
    boot.evaluate()
    expect(boot.invoke).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    expect(boot.timers.size).toBe(0)
    boot.evaluate()
    expect(boot.invoke).toHaveBeenCalledTimes(2)
  })

  it('never sends a second report while the first one is in flight', () => {
    const boot = setup(bootCard(['Failed to load plugins', 'dsh-tauri-kernel']), () => new Promise(() => {}))
    boot.evaluate()
    boot.evaluate()
    expect(boot.invoke).toHaveBeenCalledOnce()
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
