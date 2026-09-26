import type { SshFetchFn } from './api'
import type { SshMachineListValue } from './types'
import { describe, expect, it, vi } from 'vitest'
import { createSshApiClient } from './api'

/** 组一个返回固定信封的 fetch mock。 */
function fakeFetch(envelope: unknown, status = 200): SshFetchFn {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => envelope }) as unknown as Response)
}

const listValue: SshMachineListValue = {
  items: [
    { id: 'b', name: 'beta', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4002', color: '#123456', tintBorder: true },
    { id: 'a', name: 'alpha', state: 'disconnected', lastError: 'boom', authMethod: 'key', nextRetryAt: 1725000000000 },
  ],
  discovered: [
    { id: 'alias', name: 'alias-host', state: 'disconnected' },
  ],
}

describe('createSshApiClient', () => {
  it('listMachines 合并手动机器与别名机器并按名排序，丢掉缺字段的坏行', async () => {
    const fetchFn = fakeFetch({
      ok: true,
      value: {
        enabled: true,
        items: [...listValue.items, { id: '', name: 'bad', state: 'connected' }, { id: 'x' }],
        discovered: listValue.discovered,
      },
    })
    const client = createSshApiClient(fetchFn, () => 'http://127.0.0.1:3081')
    const { enabled, machines } = await client.listMachines()
    expect(enabled).toBe(true)
    // 按 name 排序：alias-host < alpha < beta
    expect(machines.map(row => row.id)).toEqual(['alias', 'a', 'b'])
    expect(machines[2]).toMatchObject({ color: '#123456', tintBorder: true, tunnelBaseUrl: 'http://127.0.0.1:4002' })
    // 增量投影：authMethod 与 nextRetryAt 随行透出（切换器倒计时/凭据后缀用）
    expect(machines[1]).toMatchObject({ authMethod: 'key', nextRetryAt: 1725000000000 })
    // 请求形状：POST /api-ssh + machine.list 信封
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:3081/api-ssh',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ method: 'machine.list', payload: {} }) }),
    )
  })

  it('未启用时返回空列表与 enabled=false（壳层据此隐藏切换器）', async () => {
    const fetchFn = fakeFetch({ ok: true, value: { enabled: false, items: [], discovered: [] } })
    const client = createSshApiClient(fetchFn, () => 'http://127.0.0.1:3081')
    await expect(client.listMachines()).resolves.toEqual({ enabled: false, machines: [] })
  })

  it('connect 透传 machineId 并返回隧道 URL', async () => {
    const fetchFn = fakeFetch({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:4004' } })
    const client = createSshApiClient(fetchFn, () => 'http://127.0.0.1:3081')
    await expect(client.connect('m1')).resolves.toEqual({ tunnelBaseUrl: 'http://127.0.0.1:4004' })
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:3081/api-ssh',
      expect.objectContaining({ body: JSON.stringify({ method: 'machine.connect', payload: { machineId: 'm1' } }) }),
    )
  })

  it('ok:false 信封抛引擎错误消息（供切换器降级/失败呈现）', async () => {
    const client = createSshApiClient(
      fakeFetch({ ok: false, error: { code: 'machine-reconnecting', message: 'machine is reconnecting' } }),
      () => 'http://127.0.0.1:3081',
    )
    await expect(client.connect('m1')).rejects.toThrow('machine is reconnecting')
  })

  it('hTTP 非 200、空响应体与网络失败都抛错（本地实例不可达 / 无 SSH API）', async () => {
    const httpError = createSshApiClient(fakeFetch({ ok: true, value: {} }, 503), () => 'http://127.0.0.1:3081')
    await expect(httpError.listMachines()).rejects.toThrow('SSH_API_HTTP_503')

    // 405 是「插件未挂载」的实况（内核 fallback 只答状态码、正文为空）：
    // 必须是稳定的 HTTP 错误码，而不是原生 JSON 解析异常。
    const routeMissing = createSshApiClient(
      vi.fn(async () => ({ ok: false, status: 405, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } }) as unknown as Response),
      () => 'http://127.0.0.1:3081',
    )
    await expect(routeMissing.listMachines()).rejects.toThrow('SSH_API_HTTP_405')

    // 200 但没有可解析正文：同样归到稳定错误码
    const emptyBody = createSshApiClient(
      vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } }) as unknown as Response),
      () => 'http://127.0.0.1:3081',
    )
    await expect(emptyBody.listMachines()).rejects.toThrow('SSH_API_HTTP_200')

    const networkError = createSshApiClient(
      vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as SshFetchFn,
      () => 'http://127.0.0.1:3081',
    )
    await expect(networkError.listMachines()).rejects.toThrow('fetch failed')
  })
})
