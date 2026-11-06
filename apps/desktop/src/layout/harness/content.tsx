import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { isHostedDocument } from '@/utils/window-presentation'
import { HostedContent } from './hosted-content'

export interface HarnessContentProps {
  srcOverride?: string | null
  borderTint?: string | null
}

export function HarnessContent({ srcOverride = null, borderTint = null }: HarnessContentProps) {
  const { webviewSrc } = useStore(store.harness)
  const src = srcOverride ?? webviewSrc

  return (
    <If
      cond={isHostedDocument()}
      then={<HostedContent />}
      else={(
        <div
          className="relative flex min-h-0 flex-1 bg-panel pointer-events-auto"
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
