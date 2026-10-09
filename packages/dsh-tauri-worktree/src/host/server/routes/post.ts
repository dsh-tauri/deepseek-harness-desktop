import type { EventHandlerRequest } from 'h3'
import type { CreateBody, WorktreeCreate } from './index.types'
import { defineEventHandler, readBody } from 'h3'
import { handoff } from '../../service/handoff'
import { sessionContext } from '../../service/session-context'
import { worktree } from '../../service/worktree'
import { worktreeKey } from '../../utils/paths'

export default defineEventHandler<EventHandlerRequest, Promise<WorktreeCreate>>(async (event) => {
  const body = (await readBody<CreateBody>(event)) ?? {}
  const sessionId = String(body.sessionId ?? '')
  const sourceSessionId = String(body.sourceSessionId ?? sessionId)
  if (!sessionId) {
    event.res.status = 400
    return { error: '缺少 sessionId' }
  }
  const projectPath = await sessionContext.resolve(sourceSessionId)
  if (!projectPath) {
    event.res.status = 400
    return { error: '无法解析会话工作目录：会话尚未就绪，请稍后重试' }
  }
  const created = await worktree.create(projectPath, sessionId, {
    sourceSessionId,
    carryStaged: body.carryStaged === true,
  })
  if (!created.ok) {
    event.res.status = 400
    return { error: created.error }
  }

  let inherited = false
  if (body.inherit === true) {
    const inheritedSession = await handoff.inherit(sourceSessionId, sessionId, created.binding.worktreePath)
    if (!inheritedSession.ok) {
      event.res.status = 500
      return { error: `会话历史继承失败：${inheritedSession.error}；工作树已保留：${created.binding.worktreePath}` }
    }
    inherited = true
  }

  const { binding } = created
  return {
    ok: true,
    hash: binding.hash,
    dirname: binding.dirname,
    worktreeKey: worktreeKey(binding.hash, binding.dirname),
    worktreePath: binding.worktreePath,
    projectPath: binding.projectPath,
    sourceSessionId: binding.sourceSessionId,
    log: created.log,
    existed: created.existed,
    inherited,
  }
})
