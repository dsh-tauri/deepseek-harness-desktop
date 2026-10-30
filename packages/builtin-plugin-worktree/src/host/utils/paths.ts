import { createHash } from 'node:crypto'
import { DSH_HOME } from 'dsh-tauri'
import { join } from 'pathe'
import { TRASH_DIR, WORKTREES_DIR } from '../config/constants'

export function computeHash(projectPath: string, sessionId: string): string {
  return createHash('sha256').update(`${projectPath}:${sessionId}`).digest('hex').slice(0, 12)
}

export function worktreePath(hash: string, dirname: string): string {
  return join(DSH_HOME, WORKTREES_DIR, hash, dirname)
}

export function worktreeKey(hash: string, dirname: string): string {
  return `${hash}/${dirname}`
}

export function worktreeTrashPath(hash: string, dirname: string): string {
  return join(DSH_HOME, TRASH_DIR, hash, dirname)
}

export function parseWorktreeKey(key: string): { hash: string, dirname: string } | null {
  const segments = String(key ?? '').split('/')
  if (segments.length !== 2)
    return null
  const [hash, dirname] = segments
  return hash && dirname ? { hash, dirname } : null
}
