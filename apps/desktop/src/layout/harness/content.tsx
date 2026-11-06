import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { isHostedDocument } from '@/utils/window-presentation'
import { HostedContent } from './hosted-content'

export interface HarnessContentProps {
  srcOverride?: string | null
  borderTint?: string | null
}

/**
 * Harness 内容分支。
 *
 * - 文档即 DSH（生产）：DSH 就是本 webview 的文档，壳层浮在它上面，无需子视图。
 * - 独立壳层页（dev）：DSH 由页面内的 `<webview>` 标签承载。这样壳层是普通可热更新
 *   的 React 树，DSH 在独立 webview 里单独加载，改壳层组件不必重建 `shell.mjs`。
 */
export function HarnessContent({ srcOverride = null, borderTint = null }: HarnessContentProps) {
  const { webviewSrc } = useStore(store.harness)
  const src = srcOverride ?? webviewSrc

  return (
    <If
      cond={isHostedDocument()}
      then={<HostedContent />}
      else={(
        <div
          className="relative flex min-h-0 flex-1"
          style={borderTint ? { borderColor: borderTint, borderWidth: 2, borderStyle: 'solid' } : undefined}
        >
          <If
            cond={src !== ''}
            then={<webview src={src} className="h-full w-full" data-testid="dsh-harness-webview" />}
          />
        </div>
      )}
    />
  )
}
