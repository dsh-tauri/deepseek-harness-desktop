import { task } from '../service/task'
import { nullableText, scheduleParameters, textBlock } from '../utils/tool'

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    taskId: { type: 'string' },
    nextRunAt: nullableText,
    task: { type: 'object', additionalProperties: true },
    error: { type: 'string' },
    code: { type: 'string' },
  },
  required: ['ok'],
}

export function createTaskTool(): any {
  return {
    name: 'scheduler_create',
    description:
      'Create a scheduled task that runs a prompt automatically on a schedule. '
      + 'Use when the user asks to set up a daily, weekly, workday, or interval automation '
      + '(e.g. "write a daily report every weekday at 9am"). Explicitly choose delivery: '
      + 'this-session queues a reminder in the originating session using its existing resources; '
      + 'new-session starts a separate agent run with its own workspace/permission/model. Do not impersonate another session.',
    parameters: {
      type: 'object',
      properties: {
        delivery: { type: 'string', enum: ['this-session', 'new-session'], description: 'Required explicit delivery mode.' },
        sessionId: { type: 'string', description: 'this-session only; omit to bind to the owning current initiator.' },
        name: { type: 'string', description: 'Task name, e.g. "Daily report".' },
        prompt: { type: 'string', description: 'The task instruction run in the scheduled session.' },
        schedule: scheduleParameters,
        workspaceId: { type: 'string', description: 'Optional target workspace id (cwd).' },
        permission: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Permission boundary (read-only / workspace-write / danger-full-access). Default read-only.' },
        provider: { type: 'string', description: 'Optional pinned model provider id (pair with model).' },
        model: { type: 'string', description: 'Optional pinned model id (pair with provider).' },
        reasoningEffort: { type: 'string', description: 'Optional pinned reasoning effort id for the selected model.' },
      },
      required: ['delivery', 'name', 'prompt', 'schedule'],
    },
    output: {
      schema: outputSchema,
      render: (_args: unknown, value: unknown) => textBlock(JSON.stringify(value)),
    },
    async execute(args: any) {
      const result = await task.create({
        delivery: args.delivery,
        sessionId: args.sessionId,
        name: String(args.name ?? ''),
        prompt: String(args.prompt ?? ''),
        schedule: args.schedule,
        workspaceId: args.workspaceId === undefined ? undefined : String(args.workspaceId),
        permission: args.permission === undefined ? undefined : String(args.permission),
        provider: args.provider === undefined ? undefined : String(args.provider),
        model: args.model === undefined ? undefined : String(args.model),
        reasoningEffort: args.reasoningEffort === undefined ? undefined : String(args.reasoningEffort),
      })
      if (!result.ok)
        return result
      return { ok: true, taskId: result.task.id, nextRunAt: result.task.nextRunAt ?? null, task: result.task }
    },
  }
}
