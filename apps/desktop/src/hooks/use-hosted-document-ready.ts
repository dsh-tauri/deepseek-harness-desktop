import { useMount, useMutationObserver } from '@reause/core'
import { useRef, useState } from 'react'
import { isHostedServiceDocument } from '@/utils/window-presentation'

/** 上游 boot 页失败卡片标题（`@deepseek-ai/dsh-client-web` 的 boot-page），逐项状态行紧随其后。 */
const BOOT_FAILURE_TITLE = 'Failed to load plugins'

/** 逐叶子取文本：失败卡片是「标题 + 逐项状态行」的多行结构，行边界就是插件定位所依赖的包名上下文。 */
function collectLines(node: Element, out: string[] = []): string[] {
  if (node.children.length === 0) {
    const text = (node.textContent ?? '').trim()
    if (text !== '')
      out.push(text)
    return out
  }
  for (const child of node.children)
    collectLines(child, out)
  return out
}

/** boot 失败卡片原文（逐行）；页面上没有这张卡片时返回 null。 */
function bootFailureDetail(): string | null {
  const boot = document.querySelector('[data-dsh-boot]')
  if (boot === null)
    return null
  const rows = collectLines(boot)
  const at = rows.findIndex(row => row.includes(BOOT_FAILURE_TITLE))
  return at < 0 ? null : rows.slice(at).join('\n')
}

/**
 * 「文档即 DSH」形态的就绪探测：DSH 主框架渲染完成才算就绪。
 * 插件激活失败时上游 boot 页换成失败卡片、应用永不挂载，壳层只等主框架会永远停在
 * 加载页，故失败卡片也算未就绪，并把卡片原文经 `onBootFailure` 交给壳层切错误页（#1497）。
 */
export function useHostedDocumentReady(onBootFailure?: (detail: string) => void) {
  const [ready, setReady] = useState(false)
  const targetRef = useRef<HTMLElement | null>(document.body)
  const failureHandlerRef = useRef(onBootFailure)
  failureHandlerRef.current = onBootFailure
  const reportedRef = useRef(false)

  function checkDocument() {
    const failure = bootFailureDetail()
    if (failure !== null) {
      setReady(false)
      if (!reportedRef.current) {
        reportedRef.current = true
        failureHandlerRef.current?.(failure)
      }
      return
    }
    reportedRef.current = false
    const frame = document.querySelector('div[class$="_frame"]')
    const style = frame ? getComputedStyle(frame) : null
    setReady(isHostedServiceDocument() && frame !== null && frame.childElementCount > 0
      && style?.display !== 'none' && style?.visibility !== 'hidden')
  }

  useMutationObserver(targetRef, checkDocument, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
  useMount(checkDocument)
  return ready
}
