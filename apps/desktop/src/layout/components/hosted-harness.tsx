import { useMount, useWatch } from '@reause/core'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { isHostedDocument } from './window-presentation'

/**
 * 主窗口「文档即 DSH」时的内容占位。
 *
 * 新架构下 DSH 就是本 webview 的文档，不需要原生子视图；这里只负责把壳层状态从
 * 「启动中」推进到「已就绪」，并在服务异常时让壳层覆盖错误页。DSH 页面本身由
 * 主窗口 webContents 直接渲染，与壳层共享同一棵 DOM 树。
 */
export function HostedHostedHarness() {
  const harness = useStore(store.harness)

  useMount(() => {
    store.harness.markWebviewLoaded()
    store.harness.markWebviewAlive(harness.webviewKey)
    store.harness.markWebviewBootReady()
  })

  useWatch([harness.webviewKey], () => {
    store.harness.markWebviewLoaded()
    store.harness.markWebviewAlive(harness.webviewKey)
  })

  return (
    <div className="relative min-h-0 flex-1" data-testid="dsh-hosted-document">
      <If cond={harness.showWebviewError}>
        <div className="absolute inset-0 bg-panel" />
      </If>
    </div>
  )
}

/** 仅在「文档即 DSH」时渲染占位，其余窗口形态仍走原生子视图。 */
export function HostedHarness() {
  if (!isHostedDocument())
    return null
  return <HostedHostedHarness />
}
