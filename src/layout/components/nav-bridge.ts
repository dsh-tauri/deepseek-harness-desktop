import type { NavbarProps } from './navbar'
import type { IframeOutboundMessage } from '@/hooks/use-iframe-post'

/** 设置浮层分区 id：SSH（dsh-tauri-ssh 插件注册的唯一分区，内部再用 Tabs 分页）。 */
export const SSH_SECTION = 'dsh-tauri-ssh'

/** SSH 分区内的标签页 id（与插件 `SSH_TAB_*` 约定一致）。 */
export const SSH_TAB_MACHINES = 'machines'

/** 同步到远端标签页 id。 */
export const SSH_TAB_SYNC = 'sync'

/**
 * 导航栏回调桥：把每个导航栏动作翻译成一条宿主 → iframe 协议消息。
 *
 * iframe 缺席（未 ready / 服务不健康）时返回空表——没有协议接收方就不下发
 * 依赖它的回调，导航栏据此禁用对应按钮，而不是留死按钮。判定必须与
 * `Webview` 的 `renderContent()` 中 iframe 的条件完全一致。
 *
 * @param post - 宿主 → iframe 的发送器（`useIframePost`）。
 * @param live - iframe 是否已挂载（`status === 'ready' && serviceHealthy`）。
 * @returns 传给 `Navbar` 的回调表。
 */
export function navBridgeOf(post: (message: IframeOutboundMessage) => void, live: boolean): Partial<NavbarProps> {
  if (!live)
    return {}
  return {
    onToggleSidebar: () => post({ type: 'dsh://sidebar:toggle' }),
    onNewChat: () => post({ type: 'dsh://session:new' }),
    onOpenFolder: () => post({ type: 'dsh://workspace:add' }),
    // 机器管理与同步同属 SSH 分区：分区相同，靠 tab 字段落到对应标签页
    onOpenMachineManager: () => post({ type: 'dsh://settings:open', section: SSH_SECTION, tab: SSH_TAB_MACHINES }),
    onOpenSyncToRemote: () => post({ type: 'dsh://settings:open', section: SSH_SECTION, tab: SSH_TAB_SYNC }),
  }
}
