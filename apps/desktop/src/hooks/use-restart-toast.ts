import { useMount, useWatch } from '@reause/core'
import { useState } from 'react'
import { useStore } from 'valtio-define'
import { harness } from '@/store/modules/harness'
import { useHostedDocumentReady } from './use-hosted-document-ready'

export function useRestartToast() {
  const { status, errorMsg } = useStore(harness)
  const [pending, setPending] = useState(false)
  const documentReady = useHostedDocumentReady()

  function checkDocument() {
    if (!pending)
      return
    if (status === 'error') {
      void harness.finishRestartNotification('error', errorMsg).then(settled => setPending(!settled))
      return
    }
    if (!documentReady)
      return
    void harness.completeRestartDocument().then(settled => setPending(!settled))
  }

  useWatch([pending, status, documentReady], checkDocument)
  useMount(() => {
    void harness.restoreRestartToast().then(setPending)
  })
}
