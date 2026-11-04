import type { MenuItem } from 'dsh-tauri-ui/client'
import type { ActionOutcome, SessionsRuntimeLike, WorkspacesRuntimeLike } from '../types'

/** 官方菜单项转交所需的调度器与失败回调（副作用一律经 controller 托管）。 */
export interface OfficialSelectOptions {
  workspace?: boolean
  schedule: (fn: () => void, ms: number) => void
  onFailure: (message: string) => void
}

/** 菜单项附加属性：前置图标、官方快捷键键帽、危险态。 */
export interface MenuItemOptions {
  icon?: MenuItem['icon']
  shortcut?: MenuItem['shortcut']
  danger?: boolean
}

/** 菜单组装面：builder 只声明「有哪些项」，官方 `Menu` 的渲染与副作用留在 feature 内。 */
export interface MenuComposer {
  sessions: SessionsRuntimeLike
  workspaces: WorkspacesRuntimeLike
  add: (label: string, action: () => Promise<ActionOutcome | void> | void, options?: MenuItemOptions) => void
  split: () => void
  toast: (message: string) => void
  copyText: (value: string, message: string) => Promise<void>
  close: () => void
  delegate: (workspace: boolean) => OfficialSelectOptions
}
