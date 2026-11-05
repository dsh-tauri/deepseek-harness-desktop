import { useMount, useWatch } from '@reause/core'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'

/**
 * 「文档即 DSH」时的内容占位。
 *
 * DSH 已是本 webview 的文档，不需要原生子视图；这里只把壳层状态推进到就绪，
 * 并在服务异常时铺一层底色让错误页可读。
 */
export function HostedContent() {
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
