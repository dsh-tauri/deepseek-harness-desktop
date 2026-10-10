import type { TaskInput } from '../types'
import { scheduler } from '../service/scheduler'
import { task } from '../service/task'
import { nullableText, scheduleParameters, textBlock } from '../utils/tool'

const TEXT_FIELDS = ['name', 'prompt', 'workspaceId', 'permission', 'provider', 'model', 'reasoningEffort'] as const

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    taskId: { type: 'string' },
    nextRunAt: nullableText,
    ran: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['ok'],
}

export function updateTaskTool(): any {
  return {
    name: 'scheduler_update',
    description:
      'Update a scheduled task by id: rename it, rewrite its instruction, replace its schedule, '
      + 'pause or resume it (enabled), or change the workspace/permission/model used by its runs. '
      + 'Omitted fields keep their current value; inactive tasks cannot be restarted and live runs cannot be edited. '
      + 'this-session inherits the bound session resources and rejects overrides. '
      + 'Set run_now to also trigger an immediate manual run without consuming the next scheduled occurrence.',
    parameters: {
      type: 'object',
      properties: {
        expected: { type: 'object', additionalProperties: true, description: 'Optional complete task snapshot for optimistic concurrency; obtain from scheduler_list.' },
        delivery: { type: 'string', enum: ['this-session', 'new-session'], description: 'New delivery mode; resources cannot override this-session.' },
        sessionId: { type: 'string', description: 'Bound session for this-session only.' },
        task_id: { type: 'string', description: 'Task id.' },
        name: { type: 'string', description: 'New task name.' },
        prompt: { type: 'string', description: 'New task instruction.' },
        schedule: scheduleParameters,
        enabled: { type: 'boolean', description: 'true to resume, false to pause.' },
        workspaceId: { type: 'string', description: 'New target workspace id (cwd).' },
        permission: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'New permission boundary.' },
        provider: { type: 'string', description: 'New pinned model provider id (pair with model).' },
        model: { type: 'string', description: 'New pinned model id (pair with provider).' },
        reasoningEffort: { type: 'string', description: 'New pinned reasoning effort id.' },
        run_now: { type: 'boolean', description: 'Also trigger an immediate manual run after the update.' },
      },
      required: ['task_id'],
    },
    output: {
      schema: outputSchema,
      render: (_args: unknown, value: unknown) => textBlock(JSON.stringify(value)),
    },
    async execute(args: any) {
      const id = String(args.task_id ?? '')
      const result = args.expected === undefined
        ? await task.update(id, patchOf(args))
        : await task.update(id, patchOf(args), args.expected)
      if (!result.ok)
        return { ok: false, error: result.error, ...(result.code ? { code: result.code } : {}) }
      const updated = { ok: true, taskId: result.task.id, nextRunAt: result.task.nextRunAt ?? null }
      if (args.run_now !== true)
        return updated
      const run = await scheduler.trigger(id)
      if (!run.ok)
        return { ok: false, error: `更新已保存，但立即运行失败：${run.error}` }
      return { ...updated, ran: true }
    },
  }
}

// --- internal ---

function patchOf(args: any): Partial<TaskInput> {
  const patch: Record<string, unknown> = {}
  for (const field of TEXT_FIELDS) {
    if (args[field] !== undefined)
      patch[field] = String(args[field])
  }
  if (args.delivery !== undefined)
    patch.delivery = args.delivery
  if (args.sessionId !== undefined)
    patch.sessionId = args.sessionId
  if (args.schedule !== undefined)
    patch.schedule = args.schedule
  if (args.enabled !== undefined)
    patch.enabled = args.enabled === true
  return patch as Partial<TaskInput>
}
