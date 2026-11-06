import { createSharedHook, useMount, useMutationObserver } from '@reause/core'
import { useRef, useState } from 'react'
import { isHostedServiceDocument } from '@/utils/window-presentation'

export const useHostedDocumentReady = createSharedHook(() => {
  const [ready, setReady] = useState(false)
  const targetRef = useRef<HTMLElement | null>(document.body)

  function checkDocument() {
    const frame = document.querySelector('div[class$="_frame"]')
    const style = frame ? getComputedStyle(frame) : null
    setReady(isHostedServiceDocument() && frame !== null && frame.childElementCount > 0
      && style?.display !== 'none' && style?.visibility !== 'hidden')
  }

  useMutationObserver(targetRef, checkDocument, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
  useMount(checkDocument)
  return ready
})
