import type { ToastOverlayContent } from './types'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useListen } from '@/hooks/use-listen'

/**
 * 更新提示覆盖窗口的内容。
 *
 * 它是独立窗口，读不到主窗口的 store 与 i18n：全部文案（标题 / 描述 / 按钮）由主窗口
 * 算好后随载荷传来。这里只负责渲染与两个动作——「立即更新」「关闭」，都转交主窗口处理。
 */
export function App() {
  const [content, setContent] = useState<ToastOverlayContent | null>(null)

  useListen<ToastOverlayContent>('dsh://toast-overlay:content', ({ payload }) => {
    setContent(payload)
  })

  useEffect(() => {
    // 首次展示时 content 事件可能早于本窗口 webview 就绪，补读一次当前内容。
    void invoke<ToastOverlayContent | null>('get_toast_overlay_content')
      .then((value) => {
        if (value !== null)
          setContent(value)
      })
      .catch((error: unknown) => console.error('[toast-overlay] load content failed:', error))
  }, [])

  if (content === null)
    return null

  return (
    <div className="toast-overlay">
      <div className="toast-overlay__card" role="alert">
        <div className="toast-overlay__body">
          <p className="toast-overlay__title">{content.title}</p>
          <p className="toast-overlay__description">{content.description}</p>
        </div>
        <div className="toast-overlay__actions">
          <button
            type="button"
            className="toast-overlay__action"
            onClick={() => { void invoke('toast_overlay_request_update') }}
          >
            {content.action_label}
          </button>
          <button
            type="button"
            className="toast-overlay__close"
            aria-label="close"
            onClick={() => { void invoke('toast_overlay_dismiss') }}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  )
}
