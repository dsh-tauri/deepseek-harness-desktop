/**
 * 批次 08 · `dsh-tauri-scheduler` 宿主路由（契约见 `docs/specs/plugin.test.md`）。
 *
 * 本批只覆盖只读清单、缺参与落盘形态，**不触发真实执行**：`run_now` 需要模型与网络，
 * 归入后续批次。断言对象一律是外部世界（HTTP 状态码、响应字节、`<DSH_HOME>/crons/tasks`
 * 账本文件），不采信插件自报；`error` 文案逐字相等，否则「路由在跑」与「路由换了实现」
 * 在测试里不可区分。
 *
 * 复用 globalSetup 的共享宿主（`also` 默认已挂载本插件），不另起进程。唯一会落盘的
 * 用例在 `finally` 里删除自建任务并回读清单，绝不把状态留给后续用例与后续批次。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, inject, it } from 'vitest'

/** 与 `packages/dsh-tauri-scheduler/src/shared/constants.ts:9` 的 PLUGIN_ID 对齐。 */
const SCHEDULER_ROOT = '/api/tauri/scheduler'

const TASKS_PATH = `${SCHEDULER_ROOT}/tasks`
const TASKS_TOGGLE_PATH = `${SCHEDULER_ROOT}/tasks/toggle`
const TASKS_RUN_PATH = `${SCHEDULER_ROOT}/tasks/run`
const HISTORY_PATH = `${SCHEDULER_ROOT}/history`
const OPTIONS_PATH = `${SCHEDULER_ROOT}/options`
const RUNS_RECOVER_PATH = `${SCHEDULER_ROOT}/runs/recover`

/** 与 `packages/dsh-tauri-scheduler/src/host/storage/index.ts:4` 的 `base: 'crons'` 对齐。 */
const TASKS_LEDGER = join('crons', 'tasks')

interface TaskRecord {
  id: string
  name: string
  prompt: string
  enabled: boolean
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

interface CreatedPayload {
  ok?: boolean
  task?: TaskRecord
  error?: string
}

interface HistoryPayload {
  runs?: RunRecord[]
  error?: string
}

interface ActionResultPayload {
  ok?: boolean
  error?: string
}

/** `/api/**` 要求浏览器会话；Cookie 由编排在根路径用一次性 token 换得。 */
function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: inject('dshCookie'), ...extra }
}

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' }

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
  return body.tasks ?? []
}

async function readRuns(): Promise<RunRecord[]> {
  const response = await fetch(url(HISTORY_PATH), { headers: apiHeaders() })

  expect(response.status, '执行记录路由必须存在且返回 200').toBe(200)

  const body = await response.json() as HistoryPayload
  expect(Array.isArray(body.runs), '执行记录载荷必须带 runs 数组').toBe(true)
  return body.runs ?? []
}

/** 落盘账本是独立于 HTTP 的第二条通道：清单说创建成功，账本必须真的多出这条。 */
function readTasksLedger(): { version?: unknown, tasks?: unknown } {
  const path = join(inject('dshHome'), TASKS_LEDGER)
  expect(existsSync(path), `创建成功后账本必须落盘：${path}`).toBe(true)
  return JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown, tasks?: unknown }
}

/** 清理专用：结果不作断言，避免掩盖 try 块里的首个失败。 */
async function dropTask(id: string): Promise<void> {
  await fetch(url(TASKS_PATH), {
    method: 'DELETE',
    headers: apiHeaders(JSON_HEADERS),
    body: JSON.stringify({ id }),
  })
}

const TASK_INPUT = { name: 'e2e-smoke', prompt: 'say hi', schedule: { kind: 'daily', time: '09:00' } }

describe('L2 宿主路由', () => {
  it('验证干净环境下任务清单为空', async () => {
    const response = await fetch(url(TASKS_PATH), { headers: apiHeaders() })

    expect(response.status, '任务清单路由必须存在且返回 200').toBe(200)

    const body = await response.json() as TasksPayload
    expect(body.error, '成功响应不得带 error 字段').toBeUndefined()
    expect(body.tasks, '全新 scratch 里任务清单必须恰好为空数组').toEqual([])
  })

  it('验证创建任务后清单与账本一致', async () => {
    const requestedAt = Date.now()
    const createdIds: string[] = []

    try {
      const response = await fetch(url(TASKS_PATH), {
        method: 'POST',
        headers: apiHeaders(JSON_HEADERS),
        body: JSON.stringify(TASK_INPUT),
      })

      expect(response.status, '合法入参必须创建成功').toBe(200)

      const payload = await response.json() as CreatedPayload
      expect(payload.ok, '创建响应必须带 ok:true').toBe(true)

      const created = payload.task
      expect(typeof created?.id, '创建响应必须回传任务 id').toBe('string')
      if (typeof created?.id === 'string')
        createdIds.push(created.id)

      expect(created?.id, '任务 id 必须是 task-<uuid> 形态').toMatch(/^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(
        Date.parse(created?.nextRunAt ?? ''),
        '创建必须同时算出未来一次的运行时刻',
      ).toBeGreaterThan(requestedAt)

      const searched = await readTasks(TASK_INPUT.name)
      expect(searched.length, '按名称搜索必须恰好命中 1 条').toBe(1)
      expect(searched[0]?.id, '搜到的必须是刚创建的那一条').toBe(created?.id)

      const ledger = readTasksLedger()
      expect(ledger.version, '账本版本必须为 1').toBe(1)
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

  it('[反向] 验证创建任务缺字段返回 400', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['空对象', {}, '任务名称不能为空'],
      ['缺 prompt', { name: 'e2e-invalid', schedule: { kind: 'daily', time: '09:00' } }, '任务指令不能为空'],
      ['非法 schedule.kind', { name: 'e2e-invalid', prompt: 'say hi', schedule: { kind: 'nope' } }, '计划配置无效'],
    ]

    for (const [label, body, expected] of cases) {
      const response = await fetch(url(TASKS_PATH), {
        method: 'POST',
        headers: apiHeaders(JSON_HEADERS),
        body: JSON.stringify(body),
      })

      expect(response.status, `${label} 必须 400`).toBe(400)

      const payload = await response.json() as CreatedPayload
      expect(payload.error, `${label} 的 error 文案必须逐字相等`).toBe(expected)
      expect(JSON.stringify(payload), `${label} 不得走到创建成功分支`).not.toContain('"ok":true')
    }

    expect(await readTasks(), '被拒绝的创建不得留下半成品').toEqual([])
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
    expect(await notFound.json() as ActionResultPayload, '不存在文案必须逐字相等且与缺参可区分').toEqual({ error: '任务不存在' })

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
    expect(await response.json() as ActionResultPayload, '不存在文案必须逐字相等').toEqual({ error: '任务不存在' })

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

    // G-SCH-3：字段集尚未纳入事实基线，此处只断言形状，不编造字段名。
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

  it('验证执行记录清单在无记录时为空数组', async () => {
    const response = await fetch(url(HISTORY_PATH), { headers: apiHeaders() })

    expect(response.status, '执行记录清单必须可读').toBe(200)

    const body = await response.json() as HistoryPayload
    expect(Array.isArray(body.runs), '响应体必须带 runs 数组字段').toBe(true)
    expect(body.error, '成功路径不得带 error 字段').toBeUndefined()
    expect(body.runs, '未执行过任何任务的 scratch 宿主必须恰好为空数组').toEqual([])
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
