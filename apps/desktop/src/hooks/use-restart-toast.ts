import { useMount, useMutationObserver, useWatch } from '@reause/core'
import { useRef, useState } from 'react'
import { useStore } from 'valtio-define'
import { harness } from '@/store/modules/harness'
import { isHostedServiceDocument } from '@/utils/window-presentation'

export function useRestartToast() {
  const { status, errorMsg } = useStore(harness)
  const [pending, setPending] = useState(false)
  const targetRef = useRef<HTMLElement | null>(null)
  targetRef.current = pending ? document.body : null

  function checkDocument() {
    if (!pending)
      return
    if (status === 'error') {
      void harness.finishRestartNotification('error', errorMsg).then(settled => setPending(!settled))
      return
    }
    if (!isHostedServiceDocument() || !document.querySelector('div[class$="_frame"]'))
      return
    void harness.completeRestartDocument().then(settled => setPending(!settled))
  }

  useMutationObserver(targetRef, checkDocument, { childList: true, subtree: true })
  useWatch([pending, status], checkDocument)
  useMount(() => {
    void harness.restoreRestartToast().then(setPending)
  })
}
