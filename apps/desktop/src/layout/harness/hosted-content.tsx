import { useWatch } from '@reause/core'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { useHostedDocumentReady } from '@/hooks/use-hosted-document-ready'
import { store } from '@/store'
import { Loadable } from '../startup/loadable'

export function HostedContent() {
  const harness = useStore(store.harness)
  const documentReady = useHostedDocumentReady()
  const ready = documentReady && harness.serviceHealthy && !harness.restartPending

  useWatch([ready, harness.webviewKey], () => {
    if (!ready)
      return
    store.harness.markWebviewLoaded()
    store.harness.markWebviewAlive(harness.webviewKey)
    store.harness.markWebviewBootReady()
  }, { immediate: true })

  if (!ready) {
    return (
      <div className="fixed inset-x-0 bottom-0 top-11 z-10 pointer-events-auto" data-testid="dsh-hosted-loading">
        <Loadable />
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1" data-testid="dsh-hosted-document">
      <If cond={harness.showWebviewError}>
        <div className="absolute inset-0 bg-panel" />
      </If>
    </div>
  )
}
