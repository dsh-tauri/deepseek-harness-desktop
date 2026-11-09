import { useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { useListen } from './use-listen'

/**
 * Applies the persisted Harness-guest zoom factor on startup and whenever the
 * setting changes, and routes the `dsh://zoom-shortcut` event emitted by
 * `builtin-plugin-tauri` into `setting.zoom(...)`.
 *
 * The shell WebView does not know the Harness guest label; `set_harness_zoom`
 * resolves it from `HarnessDocuments` (owner = current shell window label).
 */
export function useZoom() {
  const { zoom_factor, hydrated } = useStore(store.setting)

  useWatch(
    [zoom_factor, hydrated],
    ([factor, ready]) => {
      if (!ready)
        return
      void invoke('set_harness_zoom', { zoomFactor: factor }).catch((error) => {
        console.error('[zoom] failed to apply Harness zoom:', error)
      })
    },
    { immediate: true },
  )

  useListen<{ action: 'increase' | 'decrease' | 'reset' }>(
    'dsh://zoom-shortcut',
    ({ payload }) => {
      void store.setting.zoom(payload.action)
    },
  )
}
