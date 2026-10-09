import type { OperationResult } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService, openDirectory, openUrl } from 'dsh-tauri'
import { PLUGIN_ID } from '../../shared/constants'
import { server } from '../server'
import { mutationQueue } from './mutation-queue'

/** 宿主打开能力：默认浏览器打开 http/https 外链、文件管理器打开本地目录。 */
export const opener = defineService({
  async openUrl(url: string): Promise<OperationResult> {
    return mutationQueue.start(async () => {
      try {
        await openUrl(url)
        return { ok: true }
      }
      catch (error) {
        warn(`failed to open URL ${url}`, error)
        return { ok: false, error: 'open-url-failed' }
      }
    })
  },

  async openDirectory(path: string): Promise<OperationResult> {
    return mutationQueue.start(async () => {
      try {
        await openDirectory(path)
        return { ok: true }
      }
      catch (error) {
        warn(`failed to open directory ${path}`, error)
        return { ok: false, error: 'not-a-directory' }
      }
    })
  },
})

// --- internal ---

function warn(message: string, error: unknown): void {
  try {
    getServerContext(server).logger?.warn?.(`[${PLUGIN_ID}] ${message}:`, error)
  }
  catch {}
}
