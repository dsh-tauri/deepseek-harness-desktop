import type { Dirent } from 'node:fs'
import { chmodSync, readdirSync, rmSync } from 'node:fs'
import { defineService } from 'dsh-tauri'
import { join } from 'pathe'

const RMTREE_RETRIES = { maxRetries: 10, retryDelay: 200 } as const

export const rmtree = defineService({
  remove(path: string): void {
    try {
      clearReadOnly(path)
    }
    catch {}
    rmSync(path, { recursive: true, force: true, ...RMTREE_RETRIES })
  },
})

function clearReadOnly(dir: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      continue
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      try {
        chmodSync(child, 0o777)
      }
      catch {}
      clearReadOnly(child)
    }
    else if (entry.isFile()) {
      try {
        chmodSync(child, 0o666)
      }
      catch {}
    }
  }
  try {
    chmodSync(dir, 0o777)
  }
  catch {}
}
