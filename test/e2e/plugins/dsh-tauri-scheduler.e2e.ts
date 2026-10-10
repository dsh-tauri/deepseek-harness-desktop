import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, inject, it } from 'vitest'

const SCHEDULER_ROOT = '/api/tauri/scheduler'

const TASKS_PATH = `${SCHEDULER_ROOT}/tasks`
const TASKS_TOGGLE_PATH = `${SCHEDULER_ROOT}/tasks/toggle`
const TASKS_RUN_PATH = `${SCHEDULER_ROOT}/tasks/run`
const HISTORY_PATH = `${SCHEDULER_ROOT}/history`
const OPTIONS_PATH = `${SCHEDULER_ROOT}/options`
const RUNS_RECOVER_PATH = `${SCHEDULER_ROOT}/runs/recover`
const TASKS_LEDGER = join('crons', 'tasks')
const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' }

interface TaskRecord {
  id: string
  name: string
  prompt: string
  enabled: boolean
  delivery: 'this-session' | 'new-session'
  status: 'active' | 'inactive'
  schedule: { kind: string, timeZone: string, at?: string }
  createdAt: string
  updatedAt: string
  sessionId?: string
  nextRunAt?: string
}

interface RunRecord {
  id: string
  taskId: string
}

interface TasksPayload {
  tasks?: TaskRecord[]
  error?: string
}

interface ActionResultPayload {
  ok?: boolean
  error?: string
  code?: string
}

interface CreatedPayload extends ActionResultPayload {
  task?: TaskRecord
}

interface HistoryPayload extends ActionResultPayload {
  records?: unknown[]
  runs?: RunRecord[]
  nextBefore?: string
  earlierRecordsUnavailable?: boolean
  earlierRecordsPruned?: boolean
  retention?: { days: number, records: number }
}

function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: inject('dshCookie'), ...extra }
}

function url(path: string): string {
  return `${inject('dshBaseUrl')}${path}`
}

async function readTasks(search = ''): Promise<TaskRecord[]> {
  const query = search === '' ? '' : `?search=${encodeURIComponent(search)}`
  const response = await fetch(url(`${TASKS_PATH}${query}`), { headers: apiHeaders() })

  expect(response.status, '任务清单路由必须存在且返回 200').toBe(200)

  const body = await response.json() as TasksPayload
  expect(Array.isArray(body.tasks), '清单载荷必须带 tasks 数组').toBe(true)
  expect(body.error, '成功响应不得带 error 字段').toBeUndefined()
  if (!Array.isArray(body.tasks))
    throw new Error('任务清单未返回 tasks 数组')
  return body.tasks
}

async function readRuns(): Promise<RunRecord[]> {
  const response = await fetch(url(`${HISTORY_PATH}?limit=100`), { headers: apiHeaders() })

  expect(response.status, '执行记录路由必须存在且返回 200').toBe(200)

  const body = await response.json() as HistoryPayload
  expect(body.ok, '执行记录成功响应必须带 ok:true').toBe(true)
  expect(Array.isArray(body.runs), '执行记录载荷必须带 runs 数组').toBe(true)
  if (!Array.isArray(body.runs))
    throw new Error('执行记录未返回 runs 数组')
  return body.runs
}

async function postTask(input: Record<string, unknown>, createdIds: string[]): Promise<{ response: Response, payload: CreatedPayload }> {
  const response = await fetch(url(TASKS_PATH), {
    method: 'POST',
    headers: apiHeaders(JSON_HEADERS),
    body: JSON.stringify(input),
  })
  const payload = await response.json() as CreatedPayload
  if (typeof payload.task?.id === 'string')
    createdIds.push(payload.task.id)
  return { response, payload }
}

function readTasksLedger(): { version?: unknown, tasks?: unknown } {
  const path = join(inject('dshHome'), TASKS_LEDGER)
  expect(existsSync(path), `创建成功后账本必须落盘：${path}`).toBe(true)
  return JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown, tasks?: unknown }
}

async function dropTask(id: string): Promise<void> {
  await fetch(url(TASKS_PATH), {
    method: 'DELETE',
    headers: apiHeaders(JSON_HEADERS),
    body: JSON.stringify({ id }),
  })
}

const TASK_INPUT = {
  delivery: 'new-session',
  name: 'e2e-smoke',
  prompt: 'say hi',
  schedule: { kind: 'once', at: '2030-01-01T12:00:00.000Z', timeZone: 'UTC' },
  enabled: false,
} as const

describe('L2 宿主路由', () => {
  it('验证干净环境下任务清单为空', async () => {
    const response = await fetch(url(TASKS_PATH), { headers: apiHeaders() })

    expect(response.status, '任务清单路由必须存在且返回 200').toBe(200)

    const body = await response.json() as TasksPayload
    expect(body.error, '成功响应不得带 error 字段').toBeUndefined()
    expect(body.tasks, '全新 scratch 里任务清单必须恰好为空数组').toEqual([])
  })

  it('验证暂停的新会话任务创建后清单与账本一致', async () => {
    const createdIds: string[] = []

    try {
      const { response, payload } = await postTask(TASK_INPUT, createdIds)

      expect(response.status, '合法入参必须创建成功').toBe(200)
      expect(payload.ok, '创建响应必须带 ok:true').toBe(true)

      const created = payload.task
      expect(typeof created?.id, '创建响应必须回传任务 id').toBe('string')
      expect(created?.id, '任务 id 必须是 task-<uuid> 形态').toMatch(/^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(created, '暂停任务保持 active 且保留计划，不产生绑定会话').toMatchObject({
        delivery: 'new-session',
        status: 'active',
        enabled: false,
        name: 'e2e-smoke',
        prompt: 'say hi',
        schedule: { kind: 'once', at: '2030-01-01T12:00:00.000Z', timeZone: 'UTC' },
        nextRunAt: '2030-01-01T12:00:00.000Z',
      })
      expect(created, '新会话任务不得带 sessionId').not.toHaveProperty('sessionId')

      const searched = await readTasks(TASK_INPUT.name)
      expect(searched.length, '按名称搜索必须恰好命中 1 条').toBe(1)
      expect(searched[0]?.id, '搜到的必须是刚创建的那一条').toBe(created?.id)

      const ledger = readTasksLedger()
      expect(ledger.version, '统一投递账本版本必须为 2').toBe(2)
      expect(Array.isArray(ledger.tasks), '账本必须带 tasks 数组').toBe(true)

      const ledgerIds = (ledger.tasks as TaskRecord[]).map(item => item.id).sort()
      expect(ledgerIds, '账本必须含该 id').toContain(created?.id)
      expect(ledgerIds, '账本与 HTTP 清单必须描述同一批任务').toEqual((await readTasks()).map(item => item.id).sort())

      const removed = await fetch(url(TASKS_PATH), {
        method: 'DELETE',
        headers: apiHeaders(JSON_HEADERS),
        body: JSON.stringify({ id: created?.id }),
      })
      expect(removed.status, '删除自建任务必须成功').toBe(200)
      expect(await removed.json() as ActionResultPayload, '删除成功必须带 ok:true').toEqual({ ok: true })
    }
    finally {
      for (const id of createdIds)
        await dropTask(id)
    }

    expect(await readTasks(), '用例收尾后任务清单必须回到空').toEqual([])
  })

  it('[反向] 验证更新缺少 expected 时拒绝写入并保留完整原记录', async () => {
    const createdIds: string[] = []

    try {
      const { response, payload } = await postTask({ ...TASK_INPUT, name: 'e2e-missing-expected' }, createdIds)
      expect(response.status, '更新夹具必须创建成功').toBe(200)
      expect(payload.ok, '更新夹具必须返回 ok:true').toBe(true)
      expect(typeof payload.task?.id, '更新夹具必须返回任务 id').toBe('string')
      if (!payload.task)
        throw new Error('更新夹具未返回任务记录')
      const snapshot = structuredClone(payload.task)
      expect(await readTasks(), '更新前清单必须包含创建的完整快照').toEqual([snapshot])

      const update = await fetch(url(TASKS_PATH), {
        method: 'PUT',
        headers: apiHeaders(JSON_HEADERS),
        body: JSON.stringify({ id: snapshot.id, name: 'unsafe-no-expected', prompt: 'must not persist', enabled: false }),
      })
      expect(update.status, '有效 id 缺 expected 必须返回 400').toBe(400)
      expect(await update.json(), '缺 expected 必须返回精确领域错误').toEqual({
        ok: false,
        error: '缺少完整 expected 任务记录',
        code: 'task_expected_required',
      })
      expect(await readTasks(), '拒绝缺 expected 更新后所有字段必须保持不变').toEqual([snapshot])
    }
    finally {
      for (const id of createdIds)
        await dropTask(id)
    }

    expect(await readTasks(), '更新缺 expected 用例清理后清单必须为空').toEqual([])
  })

  it('验证并发完整 expected 更新只接受一次且过期快照不能覆盖新记录', async () => {
    const createdIds: string[] = []

    try {
      const { response, payload } = await postTask({ ...TASK_INPUT, name: 'e2e-concurrent-expected' }, createdIds)
      expect(response.status, '并发更新夹具必须创建成功').toBe(200)
      expect(payload.ok, '并发更新夹具必须返回 ok:true').toBe(true)
      expect(typeof payload.task?.id, '并发更新夹具必须返回任务 id').toBe('string')
      if (!payload.task)
        throw new Error('并发更新夹具未返回任务记录')
      const snapshot = structuredClone(payload.task)
      expect(await readTasks(), '并发更新前清单必须与完整 expected 一致').toEqual([snapshot])

      const edits = [
        { name: 'e2e-concurrent-left', prompt: 'left prompt' },
        { name: 'e2e-concurrent-right', prompt: 'right prompt' },
      ]
      const results = await Promise.all(edits.map(async (edit) => {
        const response = await fetch(url(TASKS_PATH), {
          method: 'PUT',
          headers: apiHeaders(JSON_HEADERS),
          body: JSON.stringify({ id: snapshot.id, ...edit, enabled: false, expected: snapshot }),
        })
        return { response, payload: await response.json() as CreatedPayload, edit }
      }))
      expect(results.map(result => result.response.status).sort((left, right) => left - right), '同一完整 expected 的并发写入必须恰好一次成功、一次冲突').toEqual([200, 400])
      const accepted = results.find(result => result.response.status === 200)
      const rejected = results.find(result => result.response.status === 400)
      if (!accepted || !rejected)
        throw new Error('并发更新未产生一条成功和一条冲突响应')
      expect(rejected.payload, '过期完整快照必须返回 task_conflict').toEqual({
        ok: false,
        error: '任务已发生变化，请刷新后重试',
        code: 'task_conflict',
      })
      expect(accepted.payload, '成功响应必须保留暂停计划并完整应用获胜写入').toMatchObject({
        ok: true,
        task: {
          id: snapshot.id,
          ...TASK_INPUT,
          ...accepted.edit,
          status: 'active',
          createdAt: snapshot.createdAt,
          nextRunAt: '2030-01-01T12:00:00.000Z',
        },
      })
      const committed = accepted.payload.task
      if (!committed)
        throw new Error('并发更新成功响应未返回任务记录')
      expect(await readTasks(), '冲突写入不得覆盖或混入获胜任务的字段').toEqual([committed])

      const stale = await fetch(url(TASKS_PATH), {
        method: 'PUT',
        headers: apiHeaders(JSON_HEADERS),
        body: JSON.stringify({ id: snapshot.id, name: 'e2e-stale-overwrite', prompt: 'must not overwrite', enabled: false, expected: snapshot }),
      })
      expect(stale.status, '再提交原始完整快照必须返回 400').toBe(400)
      expect(await stale.json(), '顺序重放的过期快照也必须返回 task_conflict').toEqual({
        ok: false,
        error: '任务已发生变化，请刷新后重试',
        code: 'task_conflict',
      })
      expect(await readTasks(), '过期快照被拒绝后完整获胜记录必须仍然可回读').toEqual([committed])
    }
    finally {
      for (const id of createdIds)
        await dropTask(id)
    }

    expect(await readTasks(), '并发 expected 用例清理后清单必须为空').toEqual([])
  })

  it('[反向] 验证原会话投递缺少绑定时拒绝创建且清单不变', async () => {
    const before = await readTasks()
    const createdIds: string[] = []

    try {
      const { response, payload } = await postTask({ ...TASK_INPUT, delivery: 'this-session', name: 'e2e-unbound-reminder' }, createdIds)
      expect(response.status, '原会话投递缺少 sessionId 必须返回 400').toBe(400)
      expect(payload, 'HTTP 创建不能从不存在的 initiator 推断会话绑定').toEqual({
        ok: false,
        error: '原会话投递缺少可确认的 sessionId',
        code: 'session_unavailable',
      })
      expect(await readTasks(), '缺绑定的创建不得产生任务或改动已有记录').toEqual(before)
    }
    finally {
      for (const id of createdIds)
        await dropTask(id)
    }
  })

  it('[反向] 验证原会话投递绑定未知会话时拒绝创建且清单不变', async () => {
    const before = await readTasks()
    const createdIds: string[] = []

    try {
      const { response, payload } = await postTask({
        ...TASK_INPUT,
        delivery: 'this-session',
        name: 'e2e-missing-session-reminder',
        sessionId: 'session-e2e-scheduler-does-not-exist',
      }, createdIds)
      expect(response.status, `原会话投递绑定未知 sessionId 必须返回 400；响应体：${JSON.stringify(payload)}`).toBe(400)
      expect(payload, '当前宿主必须冷读确认目标不存在并返回精确领域错误').toEqual({
        ok: false,
        error: '目标会话不存在',
        code: 'session_not_found',
      })
      expect(await readTasks(), '未知会话的创建不得产生任务或改动已有记录').toEqual(before)
    }
    finally {
      for (const id of createdIds)
        await dropTask(id)
    }
  })

  it('[反向] 验证创建任务缺字段返回 400', async () => {
    const createdIds: string[] = []
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['缺投递方式', {}, '必须明确选择 delivery：this-session 或 new-session'],
      ['缺名称', { delivery: 'new-session' }, '任务名称不能为空'],
      ['缺 prompt', { delivery: 'new-session', name: 'e2e-invalid', schedule: { kind: 'daily', time: '09:00' } }, '任务指令不能为空'],
      ['非法 schedule.kind', { delivery: 'new-session', name: 'e2e-invalid', prompt: 'say hi', schedule: { kind: 'nope' } }, '计划配置无效'],
    ]

    try {
      for (const [label, body, expected] of cases) {
        const { response, payload } = await postTask({ ...body, enabled: false }, createdIds)

        expect(response.status, `${label} 必须 400`).toBe(400)
        expect(payload, `${label} 必须返回精确 task_invalid 错误，不得走到创建成功分支`).toEqual({
          ok: false,
          error: expected,
          code: 'task_invalid',
        })
      }
      expect(await readTasks(), '被拒绝的创建不得留下半成品').toEqual([])
    }
    finally {
      for (const id of createdIds)
        await dropTask(id)
    }
  })

  it('[反向] 验证删除任务的两类 400 文案可区分', async () => {
    const missingId = await fetch(url(TASKS_PATH), {
      method: 'DELETE',
      headers: apiHeaders(JSON_HEADERS),
      body: '{}',
    })
    expect(missingId.status, '缺 id 必须 400').toBe(400)
    expect(await missingId.json() as ActionResultPayload, '缺参文案必须逐字相等').toEqual({ error: '缺少任务 id' })

    const notFound = await fetch(url(TASKS_PATH), {
      method: 'DELETE',
      headers: apiHeaders(JSON_HEADERS),
      body: JSON.stringify({ id: 'task-missing' }),
    })
    expect(notFound.status, '任务不存在必须 400，而不是 500（服务内部抛错）').toBe(400)
    expect(await notFound.json() as ActionResultPayload, '不存在文案必须逐字相等且与缺参可区分').toEqual({ ok: false, error: '任务不存在', code: 'task_not_found' })

    expect(await readTasks(), '被拒绝的删除不得改动清单').toEqual([])
  })

  it('[反向] 验证立即执行不存在的任务返回 400', async () => {
    const before = await readRuns()

    const response = await fetch(url(TASKS_RUN_PATH), {
      method: 'POST',
      headers: apiHeaders(JSON_HEADERS),
      body: JSON.stringify({ id: 'task-missing' }),
    })

    expect(response.status, '未知任务必须 400').toBe(400)
    expect(await response.json() as ActionResultPayload, '不存在文案必须逐字相等').toEqual({ ok: false, error: '任务不存在', code: 'task_not_found' })

    const after = await readRuns()
    expect(after.length, '被拒绝的立即执行不得写入执行记录').toBe(before.length)
    expect(after.filter(run => run.taskId === 'task-missing'), '不得凭空产出该任务的执行记录').toEqual([])
  })

  it('验证执行记录删除的两类 400 文案可区分', async () => {
    const before = await readRuns()

    const missingId = await fetch(url(HISTORY_PATH), {
      method: 'DELETE',
      headers: apiHeaders(JSON_HEADERS),
      body: '{}',
    })
    expect(missingId.status, '缺 id 必须 400').toBe(400)
    expect(await missingId.json() as ActionResultPayload, '缺参文案必须逐字相等').toEqual({ error: '缺少执行记录 id' })

    const notFound = await fetch(url(HISTORY_PATH), {
      method: 'DELETE',
      headers: apiHeaders(JSON_HEADERS),
      body: JSON.stringify({ id: 'run-missing' }),
    })
    expect(notFound.status, '执行记录不存在必须 400').toBe(400)
    expect(await notFound.json() as ActionResultPayload, '不存在文案必须逐字相等且与缺参可区分').toEqual({ error: '执行记录不存在' })

    expect((await readRuns()).length, '被拒绝的删除不得改动执行记录').toBe(before.length)
  })

  it('验证选项端点返回可用集合并随环境变化', async () => {
    const response = await fetch(url(OPTIONS_PATH), { headers: apiHeaders() })

    expect(response.status, '选项路由必须存在且返回 200').toBe(200)

    const body = await response.json() as unknown
    expect(body, '选项载荷不得为 null').not.toBeNull()
    expect(typeof body, '选项载荷必须是对象').toBe('object')
    expect(Array.isArray(body), '选项载荷必须是对象，而不是数组').toBe(false)
    expect(Object.keys(body as Record<string, unknown>).length, '选项载荷不得为空对象').toBeGreaterThan(0)
  })

  it('[反向] 验证整任务更新缺 id 返回 400', async () => {
    const response = await fetch(url(TASKS_PATH), {
      method: 'PUT',
      headers: apiHeaders(JSON_HEADERS),
      body: '{}',
    })

    expect(response.status, '缺 id 必须 400').toBe(400)
    expect(await response.json() as ActionResultPayload, '缺参文案必须逐字相等').toEqual({ error: '缺少任务 id' })

    expect(await readTasks(), '被拒的更新不得改动清单').toEqual([])
  })

  it('[反向] 验证启停任务缺 id 返回 400', async () => {
    const response = await fetch(url(TASKS_TOGGLE_PATH), {
      method: 'POST',
      headers: apiHeaders(JSON_HEADERS),
      body: '{}',
    })

    expect(response.status, '缺 id 必须 400').toBe(400)
    expect(await response.json() as ActionResultPayload, '缺参文案必须逐字相等').toEqual({ error: '缺少任务 id' })

    expect(await readTasks(), '被拒的启停不得改动清单').toEqual([])
  })

  it.each([
    ['全局', ''],
    ['指定任务', '?taskId=task-e2e-scheduler-history-missing'],
  ])('[反向] 验证%s历史查询缺少显式 limit 返回 400', async (label, query) => {
    const response = await fetch(url(`${HISTORY_PATH}${query}`), { headers: apiHeaders() })

    expect(response.status, `${label}历史查询不得默认为无限量或隐式 limit`).toBe(400)
    expect(await response.json(), `${label}缺 limit 的错误码与文案必须逐字相等`).toEqual({
      ok: false,
      error: 'limit 必须是 1 到 100 的整数',
      code: 'history_invalid_limit',
    })
  })

  it.each([
    ['全局', ''],
    ['指定任务', 'taskId=task-e2e-scheduler-history-missing&'],
  ])('[反向] 验证%s历史查询拒绝所有非 1 到 100 整数 limit', async (label, prefix) => {
    for (const limit of ['', '0', '101', '-1', '1.5', '1.0', 'NaN', 'Infinity', '1e2', 'invalid', '2&limit=3']) {
      const response = await fetch(url(`${HISTORY_PATH}?${prefix}limit=${limit}`), { headers: apiHeaders() })

      expect(response.status, `${label} limit=${limit} 必须返回 400`).toBe(400)
      expect(await response.json(), `${label} limit=${limit} 必须返回精确校验错误而非截断或默认分页`).toEqual({
        ok: false,
        error: 'limit 必须是 1 到 100 的整数',
        code: 'history_invalid_limit',
      })
    }
  })

  it.each([
    ['全局', ''],
    ['指定任务', 'taskId=task-e2e-scheduler-history-missing&'],
  ])('[反向] 验证%s历史查询的不存在游标返回官方错误码', async (label, prefix) => {
    const response = await fetch(url(`${HISTORY_PATH}?${prefix}limit=20&before=receipt-e2e-scheduler-does-not-exist`), { headers: apiHeaders() })

    expect(response.status, `${label}历史查询不得将未知游标静默重置为第一页`).toBe(400)
    expect(await response.json(), `${label}游标错误必须使用 delivery_cursor_not_found`).toEqual({
      ok: false,
      error: '历史游标不存在或已被清理',
      code: 'delivery_cursor_not_found',
    })
  })

  it.each([
    ['全局最小 limit', '?limit=1'],
    ['全局最大 limit', '?limit=100'],
    ['指定任务最小 limit', '?taskId=task-e2e-scheduler-history-missing&limit=1'],
    ['指定任务最大 limit', '?taskId=task-e2e-scheduler-history-missing&limit=100'],
  ])('验证%s无记录时返回完整空分页与保留策略形状', async (label, query) => {
    const response = await fetch(url(`${HISTORY_PATH}${query}`), { headers: apiHeaders() })

    expect(response.status, `${label}边界值必须可读并返回 200`).toBe(200)
    expect(await response.json(), `${label}空页必须带两类空数组、显式 false 标志和字面量保留策略，不得伪造游标`).toEqual({
      ok: true,
      records: [],
      runs: [],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
    })
  })

  it('验证执行记录恢复端点幂等且不改写记录', async () => {
    const before = await readRuns()

    const first = await fetch(url(RUNS_RECOVER_PATH), {
      method: 'POST',
      headers: apiHeaders(JSON_HEADERS),
      body: '{}',
    })

    expect(first.status, '恢复端点必须存在且返回 200').toBe(200)
    expect(await first.json() as ActionResultPayload, '恢复成功必须带 ok:true').toEqual({ ok: true })

    const second = await fetch(url(RUNS_RECOVER_PATH), {
      method: 'POST',
      headers: apiHeaders(JSON_HEADERS),
      body: '{}',
    })

    expect(second.status, '重复恢复必须幂等').toBe(200)
    expect(await second.json() as ActionResultPayload, '重复恢复必须同样带 ok:true').toEqual({ ok: true })

    expect((await readRuns()).length, '无 running 记录时恢复不得改动执行记录').toBe(before.length)
  })
})
