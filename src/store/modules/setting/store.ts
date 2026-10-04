import type { AppSettingUpdate, ZoomAction } from './types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { defineStore } from 'valtio-define'
import { APPEARANCE_DEFAULTS, normalizeAppearance } from '../../../../packages/dsh-tauri/src/shared/appearance'
import { ZOOM_FACTOR_STEP } from './constants'
import { normalizeZoomFactor } from './utils'

let refreshRevision = 0
let latestRefresh = Promise.resolve()
let zoomQueue = Promise.resolve()

export const setting = defineStore({
  state: () => ({
    proxy_url: '',
    appearance: normalizeAppearance(APPEARANCE_DEFAULTS),
    installed: false,
    port: 3080,
    harness_max_heap_mb: null as number | null,
    auto_start: true,
    cli_link_enabled: true,
    zoom_factor: 1,
    close_action: 'tray',
    backup_retention_count: 10,
    backup_include_credentials: false,
    language: null as string | null,
  }),
  actions: {
    async update(update: AppSettingUpdate): Promise<void> {
      await invoke('update_app_config', { ...update })
      await setting.refresh()
    },
    refresh(): Promise<void> {
      const revision = ++refreshRevision
      latestRefresh = invoke<typeof setting.$state>('get_app_config').then(async (value) => {
        if (revision !== refreshRevision) {
          await latestRefresh
          return
        }
        setting.$patch(value)
      })
      return latestRefresh
    },
    zoom(action: ZoomAction): Promise<void> {
      const pending = zoomQueue.then(async () => {
        const delta = action === 'increase' ? ZOOM_FACTOR_STEP : -ZOOM_FACTOR_STEP
        const zoomFactor = action === 'reset' ? 1 : normalizeZoomFactor(setting.zoom_factor + delta)
        await setting.update({ zoomFactor })
      })
      zoomQueue = pending.catch(() => {})
      return pending
    },
  },
})

// keep:effect 原生设置是唯一持久化入口；事件仅触发重读，不能把旧快照写回。
const unlisten = listen('setting_updated', () => setting.refresh().catch((error) => {
  console.error('[Setting] failed to refresh native settings:', error)
}))

import.meta.hot?.dispose(() => {
  unlisten.then(stop => stop()).catch(() => {})
})

unlisten.catch(() => {})
