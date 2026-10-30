import type { EventHandlerRequest } from 'h3'
import type { WorktreeBindings } from '../index.types'
import { existsSync } from 'node:fs'
import { defineEventHandler } from 'h3'
import { cleaner } from '../../../service/cleaner'
import { ledger } from '../../../service/ledger'
import { worktreeKey } from '../../../utils/paths'

export default defineEventHandler<EventHandlerRequest, Promise<WorktreeBindings>>(async () => ({
  bindings: ledger.list()
    .filter(binding => binding.worktreePath && existsSync(binding.worktreePath))
    .map(binding => ({
      sessionId: binding.sessionId,
      sourceSessionId: binding.sourceSessionId ?? '',
      hash: binding.hash,
      dirname: binding.dirname,
      worktreeKey: worktreeKey(binding.hash, binding.dirname),
      worktreePath: binding.worktreePath,
      projectPath: binding.projectPath,
      log: Array.isArray(binding.log) ? binding.log : [],
    })),
  jobs: cleaner.unsettled().map(job => ({
    sessionId: job.sessionId,
    jobId: job.jobId,
    state: job.state,
    error: job.error,
    worktreeKey: job.worktreeKey,
    worktreePath: job.worktreePath,
  })),
}))
