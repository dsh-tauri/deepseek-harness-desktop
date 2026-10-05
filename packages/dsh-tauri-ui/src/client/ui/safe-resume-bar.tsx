import type { ReactElement } from 'react'
import { useStore } from 'dsh-tauri/client'
import { ConversationBar, ConversationBarAction, Icon, TriangleExclamation } from '../components'
import { locale } from '../locales'
import { store } from '../store'

export interface SafeResumeBarProps {
  sessionId?: string
  recover: (sessionId: string) => Promise<void>
}

/**
 * 输入框上方的内容审核拒绝提示条：provider 原文 + 不改动原会话的恢复入口。
 *
 * 会话被审核拦截时内核只把错误写进事件流，输入框仍是一副可继续的样子；这里把「已知拒绝」
 * 从普通可继续错误里摘出来，只给安全恢复入口，避免用户点「继续」被同一份上下文反复驳回。
 */
export function SafeResumeBar({ sessionId, recover }: SafeResumeBarProps): ReactElement | null {
  locale.useLocale()
  const { refusals } = useStore(store.safeResume)
  const state = sessionId === undefined ? undefined : refusals[sessionId]
  if (sessionId === undefined || state === undefined)
    return null
  const running = state.phase === 'running'
  return (
    <div className="box-border">
      <div className="box-border mx-auto self-center w-[calc(100%_-_2_*_var(--dsh-composer-side-clearance)_-_4_*_var(--dsh-composer-dock-inset))] max-w-[calc(var(--dsh-composer-card-max-width)_-_4_*_var(--dsh-composer-dock-inset))]">
        <ConversationBar
          data-dsh-safe-resume={sessionId}
          glyph={<Icon as={TriangleExclamation} size={14} />}
          label={locale.text('refusedTitle')}
          objective={state.message}
          error={state.phase === 'failing' ? locale.text('refusedRecoverFailed') : undefined}
          actions={(
            <ConversationBarAction
              aria-label={locale.text('refusedRecover')}
              disabled={running}
              onClick={() => void recover(sessionId)}
            >
              {locale.text('refusedRecover')}
            </ConversationBarAction>
          )}
        />
      </div>
    </div>
  )
}
