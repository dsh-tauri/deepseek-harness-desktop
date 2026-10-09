import type { HostContext } from './types'
import { clearInterval, setInterval } from 'node:timers'
import { resetRuntime } from './config/runtime'
import { handleSessionEvent } from './events/session-event'
import { handleToolsExecute } from './events/tools-execute'
import { checkoutContextProvider } from './prompts/checkout-context'
import { worktreeContextProvider } from './prompts/worktree-context'
import { worktreeSectionProvider } from './prompts/worktree-section'
import { server } from './server'
import { workspace } from './service/workspace'
import { worktree } from './service/worktree'
import { checkoutWorktreeTool } from './tools/checkout-worktree'
import { createWorktreeTool } from './tools/create-worktree'

const RECOVER_INTERVAL_MS = 5 * 60_000

export function apply(ctx: HostContext): void {
  ctx.effect(() => server(ctx), 'plugin: routes')

  ctx.tools.register(createWorktreeTool())
  ctx.tools.register(checkoutWorktreeTool())

  ctx.on('session/event', handleSessionEvent)
  ctx.on('tools/execute', handleToolsExecute)

  ctx.systemPrompt.section(worktreeSectionProvider)
  ctx.systemPrompt.context(worktreeContextProvider)
  ctx.systemPrompt.context(checkoutContextProvider)

  ctx.effect(() => {
    void workspace.unregisterLegacy()
  }, 'plugin: unregister legacy worktree workspaces')

  ctx.effect(() => {
    // 启动补跑落盘队列 + 清扫；此后单条任务由 cleaner 自己退避重试，这里只做长周期兜底
    void worktree.recover()
    const timer = setInterval(() => {
      void worktree.recover()
    }, RECOVER_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'plugin: worktree discard recovery')

  ctx.effect(() => () => resetRuntime(), 'plugin: host runtime')
}
