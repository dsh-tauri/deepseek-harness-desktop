import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { createTaskTool } from './create-task'
import { deleteTaskTool } from './delete-task'
import { listTasksTool } from './list-tasks'
import { updateTaskTool } from './update-task'

vi.mock('../service/task', () => ({ task: {} }))
vi.mock('../service/scheduler', () => ({ scheduler: {} }))

const require = createRequire(import.meta.url)
const runtimeRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const { createScope } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-scope')).href)
const { SystemPrompt } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
const DENIED_TOOL_NAMES = ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update']

function registeredTools() {
  const context = new Context()
  const prompt = new SystemPrompt(context, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const tools = new ToolRuntime(context, { mode: 'native' })
  for (const definition of [createTaskTool(), deleteTaskTool(), listTasksTool(), updateTaskTool()])
    tools.register(definition)
  return { context, prompt, tools }
}

describe('桌面调度工具名称与核心子代理限制契约', () => {
  it('只注册四个 schedule_* 工具而不保留 scheduler_* 别名', async () => {
    const { context, prompt, tools } = registeredTools()
    try {
      expect(tools.schemas().map(schema => schema.name).sort()).toEqual(DENIED_TOOL_NAMES)
      expect((await prompt.assemble({})).tools.map((schema: { name: string }) => schema.name).sort()).toEqual(DENIED_TOOL_NAMES)
      expect(tools.get('scheduler_create')).toBeUndefined()
      expect(updateTaskTool().parameters.properties.expected.description).toContain('schedule_list')
    }
    finally {
      await context.fiber.dispose()
    }
  })

  it('核心预设的 schedule_* deny 可用于子作用域并保持父作用域工具可见', async () => {
    const { context, tools } = registeredTools()
    const childKey = {}
    try {
      await context.plugin({
        inject: ['tools'],
        apply(owner: Context): void {
          const child = createScope(owner, childKey)
          owner.effect(() => () => child.dispose())
          child.ctx.tools.restrict({ deny: DENIED_TOOL_NAMES })
        },
      }).await()
      expect(tools.schemas(childKey)).toEqual([])
      expect(tools.schemas().map(schema => schema.name).sort()).toEqual(DENIED_TOOL_NAMES)
    }
    finally {
      await context.fiber.dispose()
    }
  })
})
