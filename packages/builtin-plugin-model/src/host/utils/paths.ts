import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { PLUGIN_ID, SETTINGS_FILE_NAME } from '../../shared/constants'

const PRESET_CACHE_FILE_NAME = 'model-presets.json'

function expandHome(path: string): string {
  if (path === '~')
    return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\'))
    return join(homedir(), path.slice(2))
  return path
}

function resolveDshHome(env: NodeJS.ProcessEnv): string {
  const configured = env.DSH_HOME
  const home = configured !== undefined && configured.trim().length > 0
    ? expandHome(configured)
    : join(homedir(), '.dsh')
  return resolve(home)
}

export function resolveSettingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), SETTINGS_FILE_NAME)
}

export function resolvePresetCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), PLUGIN_ID, PRESET_CACHE_FILE_NAME)
}
