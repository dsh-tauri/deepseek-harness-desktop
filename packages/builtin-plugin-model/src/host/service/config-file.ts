import type { ConfigOpenResult } from './config-file.types'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineService, openDirectory, openUrl } from 'dsh-tauri'
import { resolveSettingsFilePath } from '../utils/paths'

export const configFile = defineService({
  async resolve(): Promise<ConfigOpenResult> {
    const path = resolveSettingsFilePath()
    return { ok: true, path, opened: 'file' }
  },
  async open(): Promise<ConfigOpenResult> {
    const path = resolveSettingsFilePath()
    try {
      const servesFile = await isFile(path)
      if (servesFile)
        await openUrl(path)
      else
        await openDirectory(dirname(path))
      return { ok: true, path: servesFile ? path : dirname(path), opened: servesFile ? 'file' : 'directory' }
    }
    catch (error) {
      return { ok: false, path, error: error instanceof Error ? error.message : String(error) }
    }
  },
})

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return false
    throw error
  }
}
