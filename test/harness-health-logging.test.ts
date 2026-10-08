import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkHealthViaProxy } from '../src/store/modules/harness/utils'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

describe('harness health probe logging', () => {
  afterEach(() => {
    invokeMock.mockReset()
    vi.restoreAllMocks()
  })

  it('keeps a healthy probe silent so startup noise cannot bury the retry lines', async () => {
    invokeMock.mockResolvedValue('healthy - 70/70 client modules ready')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await checkHealthViaProxy()

    expect(result.healthy).toBe(true)
    expect(result.reason).toBe('healthy - 70/70 client modules ready')
    expect(warn).not.toHaveBeenCalled()
  })

  it('treats an unlistened port as a normal early-startup state', async () => {
    invokeMock.mockRejectedValue(
      new Error('HARNESS_NOT_READY: Harness service is not listening yet (port 3081)'),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await checkHealthViaProxy()

    expect(result.notListening).toBe(true)
    expect(result.notOwned).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('still records one retry line with the reason when the probe fails', async () => {
    invokeMock.mockRejectedValue(new Error('HARNESS_NOT_READY: boot page returned 404 Not Found'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await checkHealthViaProxy()

    expect(result.healthy).toBe(false)
    expect(result.phase).toBe('process-boot')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[Harness] health check failed, retrying:',
      expect.objectContaining({ message: 'HARNESS_NOT_READY: boot page returned 404 Not Found' }),
    )
  })
})
