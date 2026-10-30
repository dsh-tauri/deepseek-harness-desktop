import type { EventHandlerRequest } from 'h3'
import type { CheckoutBody, WorktreeCheckout } from '../index.types'
import { defineEventHandler, readBody } from 'h3'
import { handoff } from '../../../service/handoff'

export default defineEventHandler<EventHandlerRequest, Promise<WorktreeCheckout>>(async (event) => {
  const body = (await readBody<CheckoutBody>(event)) ?? {}
  const result = await handoff.checkout(
    String(body.sessionId ?? ''),
    String(body.worktreeHashDirname ?? ''),
    String(body.branchName ?? ''),
    body.carryStaged === true,
  )
  if (!result.ok) {
    event.res.status = 400
    return { error: result.error }
  }
  return {
    ok: true,
    branch: result.branch,
    projectPath: result.projectPath,
    targetSessionId: result.targetSessionId,
  }
})
