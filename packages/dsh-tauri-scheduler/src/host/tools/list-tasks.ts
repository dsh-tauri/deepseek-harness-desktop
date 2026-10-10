import { task } from '../service/task'
import { textBlock } from '../utils/tool'

export function listTasksTool(): any {
  return {
    name: 'scheduler_list',
    description: 'List the unified scheduler tasks with delivery mode, bound session, terminal status, next occurrence, and reversible enabled state.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, tasks: { type: 'array' } }, required: ['ok'] },
      render: (_args: unknown, value: unknown) => textBlock(JSON.stringify(value)),
    },
    async execute() {
      return { ok: true, tasks: await task.list() }
    },
  }
}
