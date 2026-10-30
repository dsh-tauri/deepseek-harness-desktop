import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import process from 'node:process'
import { defineService } from 'dsh-tauri'

export const opener = defineService({
  open(dir: string): boolean {
    try {
      if (!statSync(dir).isDirectory())
        return false
    }
    catch {
      return false
    }
    const target = process.platform === 'win32' ? dir.split('/').join('\\') : dir
    const launcher = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    try {
      const child = spawn(launcher, [target], { detached: true, stdio: 'ignore' })
      child.once('error', () => {})
      child.unref()
      return true
    }
    catch {
      return false
    }
  },
})
