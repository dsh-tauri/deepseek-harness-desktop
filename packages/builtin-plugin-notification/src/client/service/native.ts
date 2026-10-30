import type { NativeNotificationInput } from '../types'
import { invoke, listen } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'

interface ClickedPayload {
  tag?: string
  action?: string
  inputValue?: string
}

interface Handlers {
  onClick?: () => void
  onAction?: (action: string, inputValue: string | null) => void
}

const CLICKED_EVENT = 'dsh://notification-clicked'
const ACTION_TYPE_LIMIT = 16
const HANDLER_LIMIT = 64

const handlers = new Map<string, Handlers>()
const actionTypes = new Map<string, { id: string, actions: unknown[] }>()
let subscription: Promise<unknown> | undefined

function dispatch(payload: ClickedPayload): void {
  const entry = handlers.get(payload.tag ?? '')
  if (!entry)
    return
  if (payload.action) {
    const value = payload.inputValue
    entry.onAction?.(payload.action, typeof value === 'string' && value.length > 0 ? value : null)
    return
  }
  entry.onClick?.()
}

function ensureSubscription(): void {
  subscription ??= listen<ClickedPayload>(CLICKED_EVENT, (event: { payload?: ClickedPayload }) => dispatch(event.payload ?? {}))
    .catch((error: unknown) => {
      subscription = undefined
      console.warn(`[${PLUGIN_ID}] failed to listen notification events`, error)
    })
}

function remember(tag: string, entry: Handlers): void {
  handlers.delete(tag)
  handlers.set(tag, entry)
  while (handlers.size > HANDLER_LIMIT) {
    const oldest = handlers.keys().next().value
    if (oldest === undefined)
      break
    handlers.delete(oldest)
  }
}

function notificationId(tag: string): number {
  let hash = 0
  for (const char of tag)
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  return (Math.abs(hash) % 0x7FFFFFFF) || 1
}

async function ensurePermission(): Promise<boolean> {
  if (await invoke<boolean>('plugin:notifications|is_permission_granted'))
    return true
  return await invoke<string>('plugin:notifications|request_permission') === 'granted'
}

async function registerActions(input: NativeNotificationInput): Promise<string | undefined> {
  if (!input.actions || input.actions.length === 0)
    return undefined
  const id = `dsh-notification-${input.actions.map(action => action.id).join('-')}`
  actionTypes.delete(id)
  actionTypes.set(id, {
    id,
    actions: input.actions.map(action => ({
      id: action.id,
      title: action.title,
      foreground: true,
      input: action.input === true,
      inputPlaceholder: action.inputPlaceholder,
      inputButtonTitle: action.inputButtonTitle,
    })),
  })
  while (actionTypes.size > ACTION_TYPE_LIMIT) {
    const oldest = actionTypes.keys().next().value
    if (oldest === undefined)
      break
    actionTypes.delete(oldest)
  }
  try {
    await invoke('plugin:notifications|register_action_types', { types: [...actionTypes.values()] })
    return id
  }
  catch (error) {
    console.warn(`[${PLUGIN_ID}] registerActionTypes failed, sending without actions`, error)
    return undefined
  }
}

export function showNativeNotification(input: NativeNotificationInput): void {
  remember(input.tag, { onClick: input.onClick, onAction: input.onAction })
  ensureSubscription()
  void (async () => {
    try {
      if (!await ensurePermission())
        return
      const actionTypeId = await registerActions(input)
      await invoke('plugin:notifications|notify', {
        options: {
          id: notificationId(input.tag),
          title: input.title,
          body: input.body,
          silent: input.silent === true ? true : undefined,
          actionTypeId,
          extra: { sessionId: input.sessionId, title: input.title, tag: input.tag },
        },
      })
    }
    catch (error) {
      console.error(`[${PLUGIN_ID}] sendNotification failed`, error)
    }
  })()
}
