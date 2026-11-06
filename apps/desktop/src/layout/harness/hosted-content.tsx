import { useMount, useWatch } from '@reause/core'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { isHostedServiceDocument } from '@/utils/window-presentation'
import { Loadable } from '../startup/loadable'

export function HostedContent() {
  const harness = useStore(store.harness)

  useMount(() => {
    if (!isHostedServiceDocument())
      return
    store.harness.markWebviewLoaded()
    store.harness.markWebviewAlive(harness.webviewKey)
    store.harness.markWebviewBootReady()
  })

  useWatch([harness.webviewKey], () => {
    if (!isHostedServiceDocument())
      return
    store.harness.markWebviewLoaded()
    store.harness.markWebviewAlive(harness.webviewKey)
  })

  if (!isHostedServiceDocument())
    return <Loadable />

  return (
    <div className="relative min-h-0 flex-1" data-testid="dsh-hosted-document">
      <If cond={harness.showWebviewError}>
        <div className="absolute inset-0 bg-panel" />
      </If>
    </div>
  )
}
