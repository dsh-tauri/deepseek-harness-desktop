import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn<typeof globalThis.fetch>()
let service: typeof import('./scheduler')
let apis: typeof import('../apis')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function expectHistoryRequest(index: number, query: Record<string, string>): void {
  const call = fetchMock.mock.calls[index]
  if (!call)
    throw new Error('Expected a scheduler history HTTP request')
  const [input, options] = call
  expect(typeof input).toBe('string')
  if (typeof input !== 'string')
    throw new Error('Expected the generated history API to issue a URL string')
  const request = new URL(input, 'https://scheduler.invalid')
  expect(request.pathname).toBe('/api/tauri/scheduler/history')
  expect(Object.fromEntries(request.searchParams)).toEqual(query)
  expect(options?.method).toBe('GET')
}

beforeEach(async () => {
  vi.resetModules()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => {
    throw new Error('Unexpected scheduler HTTP request')
  })
  vi.stubGlobal('fetch', fetchMock)
  service = await import('./scheduler')
  apis = await import('../apis')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('scheduler history through generated API and the real HTTP client', () => {
  it('decodes a successful empty first page while sending the task identity and explicit limit', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      records: [],
      runs: [],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
    }))

    expect(await service.loadTaskHistory('task with /?#', 20)).toEqual({
      ok: true,
      records: [],
      runs: [],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expectHistoryRequest(0, { taskId: 'task with /?#', limit: '20' })
  })

  it('preserves a successful page receipt, exclusive next cursor and retention flags after JSON decoding', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      records: [{
        id: 'receipt-older',
        taskId: 'task-http',
        taskName: 'Original reminder',
        delivery: 'this-session',
        occurrence: '2030-01-01T12:00:00.000Z',
        trigger: 'schedule',
        sessionId: 'session-owner',
        scheduledAt: '2030-01-01T12:00:00.000Z',
        deliveredAt: '2030-01-01T12:00:01.000Z',
        messageId: 'message-delivered',
        prompt: 'Immutable reminder instruction',
      }],
      runs: [],
      nextBefore: 'receipt-older',
      earlierRecordsUnavailable: true,
      earlierRecordsPruned: true,
      retention: { days: 30, records: 200 },
    }))

    expect(await service.loadTaskHistory('task-http', 20, 'receipt-newer')).toEqual({
      ok: true,
      records: [{
        id: 'receipt-older',
        taskId: 'task-http',
        taskName: 'Original reminder',
        delivery: 'this-session',
        occurrence: '2030-01-01T12:00:00.000Z',
        trigger: 'schedule',
        sessionId: 'session-owner',
        scheduledAt: '2030-01-01T12:00:00.000Z',
        deliveredAt: '2030-01-01T12:00:01.000Z',
        messageId: 'message-delivered',
        prompt: 'Immutable reminder instruction',
      }],
      runs: [],
      nextBefore: 'receipt-older',
      earlierRecordsUnavailable: true,
      earlierRecordsPruned: true,
      retention: { days: 30, records: 200 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expectHistoryRequest(0, { taskId: 'task-http', limit: '20', before: 'receipt-newer' })
  })

  it('preserves the official cursor code and domain message from an actual HTTP 400 response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: false,
      error: '历史游标不存在或已被清理',
      code: 'delivery_cursor_not_found',
    }, 400))

    const pending = service.loadTaskHistory('task-http', 20, 'receipt-pruned')
    await expect(pending).rejects.toBeInstanceOf(Error)
    await expect(pending).rejects.toMatchObject({
      message: '历史游标不存在或已被清理',
      code: 'delivery_cursor_not_found',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expectHistoryRequest(0, { taskId: 'task-http', limit: '20', before: 'receipt-pruned' })
  })

  it.each([
    { limit: 0, before: undefined, message: 'limit 必须是 1 到 100 的整数', code: 'history_invalid_limit' },
    { limit: 20, before: '', message: '历史查询参数无效', code: 'history_invalid_query' },
  ])('preserves the non-cursor HTTP 400 domain failure $code without inventing a cursor recovery', async ({ limit, before, message, code }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: message, code }, 400))

    const pending = service.loadTaskHistory('task-http', limit, before)
    await expect(pending).rejects.toBeInstanceOf(Error)
    await expect(pending).rejects.toMatchObject({ message, code })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expectHistoryRequest(0, { taskId: 'task-http', limit: String(limit), ...(before === undefined ? {} : { before }) })
  })

  it('does not change the shared HTTP client default error normalization for a direct generated request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: false,
      error: '历史游标不存在或已被清理',
      code: 'delivery_cursor_not_found',
    }, 400))

    const pending = apis.getHistory({ taskId: 'task-http', limit: 20, before: 'receipt-pruned' })
    await expect(pending).rejects.toMatchObject({ message: '请求失败 (400): 历史游标不存在或已被清理' })
    await expect(pending).rejects.not.toHaveProperty('code')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expectHistoryRequest(0, { taskId: 'task-http', limit: '20', before: 'receipt-pruned' })
  })

  it('keeps a transport rejection as an error without fabricating a cursor code or retrying', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket closed'))

    const pending = service.loadTaskHistory('task-http', 20, 'receipt-newer')
    await expect(pending).rejects.toThrowError('socket closed')
    await expect(pending).rejects.not.toHaveProperty('code')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expectHistoryRequest(0, { taskId: 'task-http', limit: '20', before: 'receipt-newer' })
  })
})
