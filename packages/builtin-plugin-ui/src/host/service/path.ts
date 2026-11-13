import type { OpenPathResult } from './path.types'
import { defineService, openDirectory } from 'dsh-tauri'

const ABSOLUTE_PATH_PATTERN = /^(?:[a-z]:[\\/]|[\\/])/i

export const pathService = defineService({
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
