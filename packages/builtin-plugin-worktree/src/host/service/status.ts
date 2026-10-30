import { existsSync } from 'node:fs'
import { defineService } from 'dsh-tauri'
import { gitToplevel } from '../utils/git'
import { cleaner } from './cleaner'
import { ledger } from './ledger'
import { sessionContext } from './session-context'

export const status = defineService({
  async resolve(sessionId: string, jobId: string): Promise<import('../types').WorktreeStatusFacts> {
    const job = cleaner.lookup(sessionId, jobId)
    if (jobId && job && job.sessionId !== sessionId)
      return { mode: 'missing' }
    if (job?.state === 'deleting' || job?.state === 'failed') {
      return {
        mode: job.state,
        jobId: job.jobId,
        worktreeKey: job.worktreeKey,
        worktreePath: job.worktreePath,
        error: job.error,
      }
    }
    if (job?.state === 'completed')
      return { mode: 'local', jobId: job.jobId }

    const binding = ledger.load(sessionId)
    const active = binding && existsSync(binding.worktreePath) ? binding : null
    const projectPath = binding?.projectPath ?? (await sessionContext.resolve(sessionId)) ?? undefined
    const isGit = active ? true : projectPath ? Boolean(await gitToplevel(projectPath)) : null
    return active
      ? {
          mode: 'worktree',
          hash: active.hash,
          dirname: active.dirname,
          worktreeKey: `${active.hash}/${active.dirname}`,
          worktreePath: active.worktreePath,
          projectPath,
          sourceSessionId: active.sourceSessionId,
          log: Array.isArray(active.log) ? active.log : [],
          isGit,
        }
      : { mode: 'local', projectPath: projectPath ?? '', isGit }
  },
})
