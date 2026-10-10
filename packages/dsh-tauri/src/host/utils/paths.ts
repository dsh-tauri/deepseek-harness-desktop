import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

export function resolveUngroupedSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  const home = configured
    ? configured === '~'
      ? homedir()
      : /^~[\\/]/.test(configured)
        ? join(homedir(), configured.slice(2))
        : configured
    : join(homedir(), '.dsh')
  return join(resolve(home), 'ungrouped')
}
