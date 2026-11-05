import { getCurrentWindow } from '@tauri-apps/api/window'

type WindowAction = 'minimize' | 'maximize' | 'close'

/** 执行窗口控制动作；主窗口的关闭按钮只隐藏到托盘。 */
export function handleWindowAction(action: WindowAction): void {
  const appWindow = getCurrentWindow()
  switch (action) {
    case 'minimize':
      void appWindow.minimize()
      break
    case 'maximize':
      void appWindow.toggleMaximize()
      break
    case 'close':
      if (appWindow.label === 'main')
        void appWindow.hide()
      else
        void appWindow.close()
      break
  }
}
