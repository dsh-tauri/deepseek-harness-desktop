import type { ErrorAction } from '../types'
import { PLUGIN_ID } from '../constants'
import { invoke } from '../service/tauri'

export type { ErrorAction } from '../types'

export function reportPluginError(error: unknown, action: ErrorAction = 'runtime'): void {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .trim()
    .slice(0, 2000)
  if (!message)
    return
  void invoke('report_plugin_error', { id: PLUGIN_ID, error: message, action }).catch(() => {})
}
