import type { NotificationActionEvent } from '@/hooks/use-notification-action'
import type { NotificationClickEvent } from '@/hooks/use-notification-clicked'
import type { NotificationOwnerMetadata, NotificationResult } from '@/utils/notification'
import { useWatch } from '@reause/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useRef } from 'react'
import {
  buildNotificationResult,
  electNotificationOwner,
  matchesNotificationSource,
  NOTIFICATION_ACTION_MERGE_MS,
  notificationActionKey,
  writeNotificationSource,
} from '@/utils/notification'

interface PendingAction {
  payload: NotificationResult
  timer: ReturnType<typeof setTimeout>
}

/**
 * 原生通知的投递队列与握手。
 *
 * 通知由系统投递，壳层负责把它翻译成 DSH 页面的 `dsh://notification-clicked`：
 * 先按来源 origin 仲裁唯一承担窗口，再等页面发起 ready 握手后逐条投递。
 * DSH 尚未就绪期间收到的点击/动作先挂起，来源确定后补投。
 */
export function useNativeNotifications(source: string) {
  const pendingNativeRef = useRef<({ click: NotificationClickEvent } | { action: NotificationActionEvent })[]>([])
  const queueRef = useRef<NotificationResult[]>([])
  const pendingActionsRef = useRef(new Map<string, PendingAction>())
  const sourceRef = useRef('')

  // keep:effect 合并窗口必须在卸载时清理，否则残留定时器会继续投递。
  useEffect(() => {
    const pending = pendingActionsRef.current
    return () => {
      pending.forEach(({ timer }) => clearTimeout(timer))
      pending.clear()
    }
  }, [])

  // keep:effect ready 握手必须等监听注册完成后再发起，否则 DSH 已就绪时会漏掉。
  useEffect(() => {
    let disposed = false
    let flushing = false
    let unlisten: (() => void) | undefined
    const target = { kind: 'Window' as const, label: getCurrentWindow().label }
    void listen<{ sourceOrigin?: string }>('dsh://notification-ready', async ({ payload }) => {
      if (disposed || flushing || !matchesNotificationSource(payload?.sourceOrigin, sourceRef.current))
        return
      flushing = true
      try {
        const queue = queueRef.current
        while (queue.length > 0) {
          const index = queue.findIndex(item => item.sourceOrigin === payload!.sourceOrigin)
          if (disposed || index < 0 || !matchesNotificationSource(payload.sourceOrigin, sourceRef.current))
            break
          await emitTo(target, 'dsh://notification-clicked', queue[index])
          queue.splice(index, 1)
        }
      }
      catch (error) {
        console.error('[notification] delivery failed:', error)
      }
      finally {
        flushing = false
      }
    }, { target }).then((off) => {
      if (disposed) {
        off()
      }
      else {
        unlisten = off
        void emitTo(target, 'dsh://notification-ready-request').catch(error => console.error('[notification] ready request failed:', error))
      }
    }).catch(error => console.error('[notification] ready listener failed:', error))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  function deliver(payload: NotificationResult) {
    queueRef.current.push(payload)
    void emitTo({ kind: 'Window', label: getCurrentWindow().label }, 'dsh://notification-ready-request')
      .catch(error => console.error('[notification] ready request failed:', error))
  }

  async function owns(metadata?: NotificationOwnerMetadata | null): Promise<boolean> {
    if (metadata?.sourceOrigin === undefined || !matchesNotificationSource(metadata.sourceOrigin, sourceRef.current))
      return false
    try {
      const labels = (await getAllWindows()).map(window => window.label)
      return electNotificationOwner(labels, metadata, getCurrentWindow().label)
    }
    catch (error) {
      console.error('[notification] window lookup failed:', error)
      return false
    }
  }

  async function handleAction(event: NotificationActionEvent) {
    if (!sourceRef.current) {
      pendingNativeRef.current.push({ action: event })
      return
    }
    const { actionId, inputValue, notification, extra } = event
    if (typeof actionId !== 'string' || actionId === '' || actionId === 'tap')
      return
    const metadata = extra ?? notification?.extra
    if (!await owns(metadata))
      return
    const payload = buildNotificationResult(metadata, actionId, inputValue)
    const key = notificationActionKey(payload, actionId)
    const queued = pendingActionsRef.current.get(key)
    if (queued) {
      clearTimeout(queued.timer)
      pendingActionsRef.current.delete(key)
      deliver({ ...queued.payload, ...payload, inputValue: payload.inputValue || queued.payload.inputValue })
      return
    }
    const timer = setTimeout(() => {
      pendingActionsRef.current.delete(key)
      deliver(payload)
    }, NOTIFICATION_ACTION_MERGE_MS)
    pendingActionsRef.current.set(key, { payload, timer })
  }

  async function handleClick(event: NotificationClickEvent) {
    if (!sourceRef.current) {
      pendingNativeRef.current.push({ click: event })
      return
    }
    const { data } = event
    if (!await owns(data))
      return
    try {
      const appWindow = getCurrentWindow()
      if (await appWindow.isMinimized())
        await appWindow.unminimize()
      await appWindow.show()
      await appWindow.setFocus()
    }
    catch (error) {
      console.error('[notification] focus window failed:', error)
    }
    deliver({ tag: data?.tag, sessionId: data?.sessionId, sourceOrigin: data?.sourceOrigin })
  }

  useWatch([source], () => {
    // 登记的是来源 origin（协议+主机+端口），不是带令牌的完整 URL。
    sourceRef.current = URL.canParse(source) ? new URL(source).origin : ''
    writeNotificationSource(getCurrentWindow().label, sourceRef.current)
    if (!sourceRef.current)
      return
    for (const pending of pendingNativeRef.current.splice(0)) {
      if ('click' in pending)
        void handleClick(pending.click)
      else
        void handleAction(pending.action)
    }
  }, { immediate: true })

  return { handleAction, handleClick }
}
