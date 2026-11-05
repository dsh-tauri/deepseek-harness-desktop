import { getCurrentWindow } from '@tauri-apps/api/window'

type WindowAction = 'minimize' | 'maximize' | 'close'

/** 执行窗口控制动作；主窗口的关闭按钮只隐藏到托盘。 */
export function handleWindowAction(action: WindowAction): void {
  const appWindow = getCurrentWindow()
  // 这些调用一旦被 ACL 拒绝就完全静默，界面上只是「按钮没反应」，日志里也没有线索。
  const report = (error: unknown) => {
    console.error(`[Window] ${action} failed:`, error)
  }
  switch (action) {
    case 'minimize':
      void appWindow.minimize().catch(report)
      break
    case 'maximize':
      void appWindow.toggleMaximize().catch(report)
      break
    case 'close':
      if (appWindow.label === 'main')
        void appWindow.hide().catch(report)
      else
        void appWindow.close().catch(report)
      break
  }
}
