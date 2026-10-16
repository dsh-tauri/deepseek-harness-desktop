export interface NativeNotificationMessage {
  type: 'dsh://native-notification'
  title: string
  body: string
  sessionId: string
  tag: string
  silent: boolean
}

export interface NotificationAdapter {
  isForeground: () => boolean
  checkPermission: () => Promise<boolean>
  requestPermission: () => Promise<boolean>
  deliver: (message: NativeNotificationMessage, origin: string, identifier?: string) => Promise<void>
  reportError: (message: string, error: unknown) => void
}

export function notificationIdFor(tag: string): string | undefined {
  if (!tag)
    return undefined
  let hash = 0
  for (let index = 0; index < tag.length; index++)
    hash = (Math.imul(hash, 31) + tag.charCodeAt(index)) | 0
  return String(Math.abs(hash) % 0x7FFFFFFF || 1)
}

export function createNotificationDispatcher(adapter: NotificationAdapter) {
  let permissionRequest: Promise<boolean> | undefined
  function ensurePermission(): Promise<boolean> {
    permissionRequest ??= (async () => {
      try {
        if (await adapter.checkPermission())
          return true
        return await adapter.requestPermission()
      }
      catch (error) {
        adapter.reportError('[notification] permission request failed:', error)
        return false
      }
    })().finally(() => { permissionRequest = undefined })
    return permissionRequest
  }
  async function notify(message: NativeNotificationMessage, origin: string): Promise<void> {
    if (adapter.isForeground())
      return
    if (!await ensurePermission() || adapter.isForeground())
      return
    try {
      await adapter.deliver(message, origin, notificationIdFor(message.tag))
    }
    catch (error) {
      adapter.reportError('[notification] send failed:', error)
    }
  }
  return { ensurePermission, notify }
}

export function createResponseCoalescer(windowMs = 250) {
  const seen = new Map<string, number>()
  return function accept(key: string, now = Date.now()): boolean {
    const previous = seen.get(key)
    if (previous !== undefined && now - previous < windowMs)
      return false
    seen.set(key, now)
    for (const [entry, time] of seen) {
      if (now - time >= windowMs)
        seen.delete(entry)
    }
    if (seen.size > 64) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined)
        seen.delete(oldest)
    }
    return true
  }
}
