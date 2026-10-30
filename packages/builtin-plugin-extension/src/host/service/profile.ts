import process from 'node:process'
import { defineService } from 'dsh-tauri'
import { profileDir } from '../utils/paths.utils'

export const profile = defineService({
  resolve(argv: readonly string[] = process.argv): string | null {
    const flag = argv.indexOf('--profile')
    if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-'))
      return argv[flag + 1]
    return null
  },

  peek(name: string): string {
    return profileDir(name)
  },
})
