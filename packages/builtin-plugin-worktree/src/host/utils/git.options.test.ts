import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { git } from './git'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(execute, { [promisify.custom]: execute }) }
})

afterEach(() => vi.resetAllMocks())

function completed(stdout: string): void {
  execute.mockImplementation(() => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('close'))
    return Object.assign(Promise.resolve({ stdout, stderr: '' }), { child })
  })
}

describe('git execution options', () => {
  it('forwards cwd, abort and timeout without a shell or small output limit', async () => {
    const signal = new AbortController().signal
    completed('  output\n')
    expect(await git(['diff', '--cached', '--binary'], 'repo', { signal, timeout: 123 })).toEqual({ ok: true, out: 'output' })
    expect(execute).toHaveBeenCalledExactlyOnceWith('git', ['diff', '--cached', '--binary'], {
      cwd: 'repo',
      signal,
      timeout: 123,
      windowsHide: true,
      maxBuffer: Infinity,
      encoding: 'utf8',
    })
  })

  it('does not launch a command when its signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled before dispatch'))
    expect(await git(['checkout', 'main'], 'repo', { signal: controller.signal })).toEqual({ ok: false, error: 'cancelled before dispatch' })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['git timed out', 'The operation was aborted'])('waits for child close before reporting %s', async (message) => {
    const child = new EventEmitter()
    const pending = Object.assign(Promise.reject(Object.assign(new Error(message), { killed: true, stderr: '' })), { child })
    execute.mockReturnValue(pending)
    let settled = false
    const result = git(['status'], 'repo', { timeout: 1 }).then((value) => {
      settled = true
      return value
    })
    await pending.catch(() => {})
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(child.listenerCount('close')).toBe(1)
    child.emit('close')
    expect(await result).toEqual({ ok: false, error: message })
    expect(child.listenerCount('close')).toBe(0)
  })
})
