import { If } from 'react-if-lite'
import { isHostedDocument } from '@/utils/window-presentation'
import { HostedContent } from './hosted-content'
import { NativeWebview } from './native-webview'

export interface HarnessContentProps {
  srcOverride?: string | null
  borderTint?: string | null
}

/** Harness 内容分支：主窗口文档即 DSH 时无需原生子视图。 */
export function HarnessContent({ srcOverride = null, borderTint = null }: HarnessContentProps) {
  return (
    <If
      cond={isHostedDocument()}
      then={<HostedContent />}
      else={<NativeWebview srcOverride={srcOverride} borderTint={borderTint} />}
    />
  )
}
