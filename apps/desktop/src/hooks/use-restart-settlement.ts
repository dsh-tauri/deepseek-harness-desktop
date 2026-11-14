import { useMount, useWatch } from '@reause/core'
import { useState } from 'react'
import { useStore } from 'valtio-define'
import { harness } from '@/store/modules/harness'
import { useHostedDocumentReady } from './use-hosted-document-ready'

/** 承接跨文档重启的原生操作：新文档就绪后向原生确认，失败则交给错误页收尾 */
export function useRestartSettlement() {
  const { status, errorMsg } = useStore(harness)
  const [pending, setPending] = useState(false)
  const documentReady = useHostedDocumentReady()

  function checkDocument() {
    if (!pending)
      return
    if (status === 'error') {
      void harness.finishRestartOperation('error', errorMsg).then(settled => setPending(!settled))
      return
    }
    if (!documentReady)
      return
    void harness.completeRestartDocument().then(settled => setPending(!settled))
  }

  useWatch([pending, status, documentReady], checkDocument)
  useMount(() => {
    void harness.restoreRestartOperation().then(setPending)
  })
}
