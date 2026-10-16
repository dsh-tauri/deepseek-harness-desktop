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

  it('returns the authoritative document from the same successful health round without probing again', async () => {
    invokeMock.mockResolvedValue({ status: 'healthy - 70/70 client modules ready', boot_html: '<html>live boot</html>', service_url: 'http://127.0.0.1:3081' })
    const result = await checkHealthViaProxy()
    expect(result).toMatchObject({ healthy: true, bootHtml: '<html>live boot</html>', bootOrigin: 'http://127.0.0.1:3081' })
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('proxy_health_check')
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

  /**
   * 端口已监听但启动页还没登记：这一轮只发一次请求（毫秒级），必须标记成可快扫的
   * 状态，同时仍留一行重试记录（启动慢的实证）。
   */
  it('marks a listening service without a boot page as a fast-retry state', async () => {
    invokeMock.mockRejectedValue(new Error('HARNESS_NOT_READY: boot page returned 404 Not Found'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await checkHealthViaProxy()

    expect(result.bootPending).toBe(true)
    expect(result.notListening).toBeUndefined()
    expect(result.healthy).toBe(false)
    expect(result.phase).toBe('process-boot')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('logs ownership loss without claiming the shared probe ran before readiness', async () => {
    invokeMock.mockRejectedValue(new Error('HARNESS_NOT_OWNED: no Harness process is owned by this app'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await checkHealthViaProxy()

    expect(result.notOwned).toBe(true)
    expect(result.healthy).toBe(false)
    expect(warn).toHaveBeenCalledExactlyOnceWith('[Harness] no owned dsh process, failing health check')
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
