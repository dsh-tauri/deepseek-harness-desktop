import type { HostContext } from '../types'
import type { OpenPathResult, SessionDirectoryStatus } from './path.types'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { getServerContext } from 'dsh-h3/utils'
import { defineService, openDirectory } from 'dsh-tauri'
import { server } from '../server'

const ABSOLUTE_PATH_PATTERN = /^(?:[a-z]:[\\/]|[\\/])/i

export const pathService = defineService({
  async resolveSessionDirectory(sessionId: string): Promise<SessionDirectoryStatus> {
    const ctx = getServerContext<HostContext>(server)
    const live = ctx.sessions?.get(sessionId)?.header
    const header = live ?? (await ctx.sessionPersistence?.stat(sessionId))?.header
    const cwd = header?.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd))
      return { status: 'unknown' }

    try {
      return (await stat(cwd)).isDirectory() ? { status: 'available' } : { status: 'not-directory', cwd }
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT')
        return { status: 'missing', cwd }
      if (code === 'ENOTDIR')
        return { status: 'not-directory', cwd }
      throw error
    }
  },
  async openDirectory(path: string): Promise<OpenPathResult> {
    if (!path || !ABSOLUTE_PATH_PATTERN.test(path))
      return { ok: false, error: 'invalid-path' }
    try {
      await openDirectory(path)
    }
    catch {
      return { ok: false, error: 'not-a-directory' }
    }
    return { ok: true }
  },
})
