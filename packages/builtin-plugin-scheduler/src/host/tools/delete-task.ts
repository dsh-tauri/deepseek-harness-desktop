import { SCHEDULE_TOOL_NAMES } from '../../shared/constants'
import { task } from '../service/task'
import { textBlock } from '../utils/tool'

export function deleteTaskTool(): any {
  return {
    name: SCHEDULE_TOOL_NAMES.delete,
    description: 'Delete a scheduled task by id (keeps run history).',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task id.' } },
      required: ['task_id'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, error: { type: 'string' } }, required: ['ok'] },
      render: (_args: unknown, value: any) => value.ok ? textBlock('✅ 已删除定时任务。') : textBlock(`❌ 删除失败：${value.error}`),
    },
    async execute(args: any) {
      const result = await task.remove(String(args.task_id ?? ''))
      if (!result.ok)
        return { ok: false, error: result.error }
      return { ok: true }
    },
  }
}
