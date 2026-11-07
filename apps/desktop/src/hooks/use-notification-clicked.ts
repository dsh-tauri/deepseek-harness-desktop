import type { PluginListener } from '@tauri-apps/api/core'
import type { NotificationExtra } from './use-notification-action'
import { onNotificationClicked } from '@choochmeque/tauri-plugin-notifications-api'
import { useEffect, useRef } from 'react'
import { isNativeNotificationAvailable } from '../../../../packages/builtin-plugin-tauri/src/client/service/tauri'

export interface NotificationClickEvent {
  id?: number
  data?: NotificationExtra
}

export function useNotificationClicked(handler: (event: NotificationClickEvent) => void): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  // keep:effect 原生通知监听需要卸载与异步注册的竞态清理。
  useEffect(() => {
    if (!isNativeNotificationAvailable())
      return
    let listener: PluginListener | undefined
    let disposed = false

    void onNotificationClicked((data) => {
      handlerRef.current((data as unknown as NotificationClickEvent | null) ?? {})
    }).then((unlisten) => {
      if (disposed)
        void unlisten.unregister()
      else
        listener = unlisten
    }).catch(error => console.error('[useNotificationClicked] failed to subscribe:', error))

    return () => {
      disposed = true
      void listener?.unregister()
    }
  }, [])
}
