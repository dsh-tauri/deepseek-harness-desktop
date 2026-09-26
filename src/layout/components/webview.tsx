import type { DshShortcutRow } from '@/hooks/use-dsh-shortcuts'
import { useRef, useState } from 'react'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { useDshShortcuts } from '@/hooks/use-dsh-shortcuts'
import { useDshStyle } from '@/hooks/use-dsh-style'
import { useIframeMessage } from '@/hooks/use-iframe-message'
import { useIframePost } from '@/hooks/use-iframe-post'
import { store } from '@/store'
import { borderTintOf } from '@/store/modules/remote'
import { Recovery } from '@/ui/plugin/recovery'
import { Iframe } from './iframe'
import { Navbar } from './navbar'
import { Setup } from './setup'
import { PreinstallSetup } from './setup-preinstall'

/** 导航桥回报消息类型（iframe → 宿主） */
interface NavBridgeMessage {
  type?: string
  collapsed?: boolean
  rows?: unknown
}

/**
 * 主区域视图（Webview）
 *
 * 壳层导航栏（Navbar）常驻顶部，根据 harness 状态动态渲染主内容区：
 * - error: 错误页 / 插件全屏恢复页
 * - preinstall: 预装插件引导页
 * - ready: 渲染标准 iframe 界面
 * - other: 通用初始化 Setup 页
 */
export function Webview() {
  // 1. 状态与引用声明
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const post = useIframePost(iframeRef)

  const [dshStyle] = useDshStyle()
  const [, setDshShortcuts] = useDshShortcuts()

  const { status, serviceHealthy } = useStore(store.harness)
  const { recovery } = useStore(store.recovery)
  const { machines, activeId, activeTunnelUrl } = useStore(store.remote)
  // 远端模式：活动机器的隧道 URL 就绪才切换（不指向空端口）；重连窗口内
  // store 粘性保留上一次 URL，等待引擎按端口稳定策略恢复
  const remoteMode = activeTunnelUrl !== ''
  const borderTint = remoteMode ? borderTintOf(machines.find(machine => machine.id === activeId)) : null

  // 2. Iframe 消息通信监听
  useIframeMessage<NavBridgeMessage>(iframeRef, (data) => {
    if (data.type === 'dsh://sidebar:collapsed') {
      setSidebarCollapsed(Boolean(data.collapsed))
    }
    else if (data.type === 'dsh://shortcuts') {
      setDshShortcuts({ rows: parseShortcutRows(data.rows) })
    }
  })

  // 4. 根据当前状态决定中间区域渲染内容
  const renderContent = () => {
    switch (status) {
      case 'error':
        return (
          <If cond={recovery.required} else={<Setup />}>
            <Recovery fullScreen />
          </If>
        )
      case 'preinstall':
        return <PreinstallSetup />
      case 'ready':
        return (
          <Iframe
            iframeRef={iframeRef}
            srcOverride={remoteMode ? activeTunnelUrl : null}
            borderTint={borderTint}
          />
        )
      default:
        return <Setup />
    }
  }

  // iframe 缺席时没有协议接收方，不下发依赖它的回调：导航栏据此隐藏侧边栏开关、
  // 禁用「新聊天」「打开文件夹」「管理机器」，而不是留死按钮。
  // 判定必须与 `renderContent()` 的 iframe 条件完全一致：`status` 回到 `error`
  // （shutdown / 客户端 boot 失败）时 iframe 已卸载，但 `serviceHealthy` 可能仍为
  // true——只看后者会把回调发给已摘除的接收方，按钮点了没反应。
  const bridge = status === 'ready' && serviceHealthy
    ? {
        onToggleSidebar: () => post({ type: 'dsh://sidebar:toggle' }),
        onNewChat: () => post({ type: 'dsh://session:new' }),
        onOpenFolder: () => post({ type: 'dsh://workspace:add' }),
        onEditAction: (action: string) => post({ type: 'dsh://edit', action }),
        onOpenShortcuts: () => post({ type: 'dsh://shortcuts:open' }),
      }
    : {}

  // 5. 统一布局输出
  return (
    <main className="relative flex flex-col min-h-0 flex-1" style={dshStyle.frame || {}}>
      <Navbar sidebarCollapsed={sidebarCollapsed} {...bridge} />
      <div className="flex min-h-0 flex-1">
        {renderContent()}
      </div>
    </main>
  )
}

/** 目录行校验：只接受有 id 与文案的行，键位逐项取字符串（桥消息按不可信输入处理）。 */
function parseShortcutRows(rows: unknown): DshShortcutRow[] {
  if (!Array.isArray(rows))
    return []
  const out: DshShortcutRow[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null)
      continue
    const entry = row as { id?: unknown, label?: unknown, keys?: unknown, aria?: unknown }
    if (typeof entry.id !== 'string' || typeof entry.label !== 'string')
      continue
    out.push({
      id: entry.id,
      label: entry.label,
      keys: Array.isArray(entry.keys) ? entry.keys.filter((key): key is string => typeof key === 'string') : [],
      ...typeof entry.aria === 'string' ? { aria: entry.aria } : {},
    })
  }
  return out
}
