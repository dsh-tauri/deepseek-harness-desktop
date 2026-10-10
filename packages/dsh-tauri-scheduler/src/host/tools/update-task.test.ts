import type { SchedulerTask } from '../types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduler } from '../service/scheduler'
import { task } from '../service/task'
import { updateTaskTool } from './update-task'

vi.mock('../service/task', () => ({ task: { update: vi.fn() } }))

vi.mock('../service/scheduler', () => ({ scheduler: { trigger: vi.fn() } }))

const taskFixture: SchedulerTask = {
  id: 'task-1',
  delivery: 'new-session',
  status: 'active',
  name: 'nightly',
  schedule: { kind: 'interval', everyMinutes: 30, timeZone: 'UTC' },
  prompt: 'run the nightly job',
  enabled: true,
  createdAt: '2025-12-31T00:00:00.000Z',
  updatedAt: '2025-12-31T00:00:00.000Z',
  nextRunAt: '2026-01-01T00:30:00.000Z',
}

const tool = updateTaskTool()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scheduler_update', () => {
  it('对外只暴露四个 agent 工具之一：名称为 scheduler_update', () => {
    expect(tool.name).toBe('scheduler_update')
  })

  it('task_id 是唯一必填参数，其余字段均可选', () => {
    expect(tool.parameters.required).toEqual(['task_id'])
    expect(Object.keys(tool.parameters.properties).sort()).toEqual([
      'delivery',
      'enabled',
      'expected',
      'model',
      'name',
      'permission',
      'prompt',
      'provider',
      'reasoningEffort',
      'run_now',
      'schedule',
      'sessionId',
      'task_id',
      'workspaceId',
    ])
  })

  it('只把显式传入的字段并入 patch，缺省字段保持不变', async () => {
    vi.mocked(task.update).mockResolvedValue({ ok: true, task: { ...taskFixture, name: 'weekly' } })

    await tool.execute({ task_id: 'task-1', name: 'weekly' })

    expect(task.update).toHaveBeenCalledWith('task-1', { name: 'weekly' })
  })

  it('吸收 toggle 语义：enabled 作为普通可更新字段写入', async () => {
    vi.mocked(task.update).mockResolvedValue({ ok: true, task: { ...taskFixture, enabled: false } })

    await tool.execute({ task_id: 'task-1', enabled: false })

    expect(task.update).toHaveBeenCalledWith('task-1', { enabled: false })
  })

  it('run_now 为真时在更新之后触发一次手动运行', async () => {
    vi.mocked(task.update).mockResolvedValue({ ok: true, task: taskFixture })
    vi.mocked(scheduler.trigger).mockResolvedValue({ ok: true })

    await expect(tool.execute({ task_id: 'task-1', name: 'nightly', run_now: true }))
      .resolves
      .toEqual({ ok: true, taskId: 'task-1', nextRunAt: '2026-01-01T00:30:00.000Z', ran: true })
    expect(scheduler.trigger).toHaveBeenCalledWith('task-1')
  })

  it('未传 run_now 时不触发运行', async () => {
    vi.mocked(task.update).mockResolvedValue({ ok: true, task: taskFixture })

    await expect(tool.execute({ task_id: 'task-1', prompt: 'again' }))
      .resolves
      .toEqual({ ok: true, taskId: 'task-1', nextRunAt: '2026-01-01T00:30:00.000Z' })
    expect(scheduler.trigger).not.toHaveBeenCalled()
  })

  it('更新失败时直接返回领域错误，不触发运行', async () => {
    vi.mocked(task.update).mockResolvedValue({ ok: false, error: '任务不存在' })

    await expect(tool.execute({ task_id: 'missing', run_now: true }))
      .resolves
      .toEqual({ ok: false, error: '任务不存在' })
    expect(scheduler.trigger).not.toHaveBeenCalled()
  })

  it('更新已保存但立即运行失败时如实回报，不掩盖已写入的更新', async () => {
    vi.mocked(task.update).mockResolvedValue({ ok: true, task: taskFixture })
    vi.mocked(scheduler.trigger).mockResolvedValue({ ok: false, error: '任务正在执行中' })

    await expect(tool.execute({ task_id: 'task-1', run_now: true }))
      .resolves
      .toEqual({ ok: false, error: '更新已保存，但立即运行失败：任务正在执行中' })
  })
})
