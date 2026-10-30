import type { ReactElement } from 'react'
import { ArrowRightFromSquare, CircleTree, ConversationBar, ConversationBarAction, Icon, TerminalLine, TrashBin, Xmark } from 'dsh-tauri-ui/client'
import { cn } from 'dsh-tauri/client'
import { useState } from 'react'
import { useWorktreeSession } from '../hooks/use-worktree-session'
import { locale } from '../locales'
import { store } from '../store'

export interface SurfaceBarProps {
  sessionId: string
}

export function WorktreeSurface({ sessionId }: SurfaceBarProps): ReactElement | null {
  locale.useLocale()
  const state = useWorktreeSession(sessionId)
  const [logOpen, setLogOpen] = useState(false)

  if (state.phase === 'idle' || (state.mode === 'local' && state.phase !== 'error'))
    return null

  const creating = state.phase === 'creating'
  const deleting = state.phase === 'deleting'
  const failed = state.phase === 'error'
  const bound = state.mode === 'worktree'
  const label = creating
    ? state.loadingLabel || locale.text('progressCreating')
    : deleting
      ? locale.text('progressDeleting')
      : failed
        ? locale.text('progressError')
        : locale.text('surfaceWorktree')

  return (
    <div className="box-border">
      <div className="box-border mx-auto self-center w-[calc(100%_-_2_*_var(--dsh-composer-side-clearance)_-_4_*_var(--dsh-composer-dock-inset))] max-w-[calc(var(--dsh-composer-card-max-width)_-_4_*_var(--dsh-composer-dock-inset))]">
        <ConversationBar
          actions={(
            <>
              {bound && !deleting && (
                <>
                  <ConversationBarAction
                    aria-label={locale.text('surfaceCheckout')}
                    iconOnly
                    onClick={() => store.worktree.patch(sessionId, { checkoutOpen: true, error: '' })}
                    title={locale.text('surfaceCheckout')}
                  >
                    <Icon as={ArrowRightFromSquare} size={14} />
                  </ConversationBarAction>
                  <ConversationBarAction
                    aria-label={locale.text('surfaceAbandon')}
                    iconOnly
                    onClick={() => store.worktree.patch(sessionId, { abandonOpen: true })}
                    title={locale.text('surfaceAbandon')}
                  >
                    <Icon as={TrashBin} size={14} />
                  </ConversationBarAction>
                </>
              )}
              {failed && !bound && (
                <ConversationBarAction
                  aria-label={locale.text('surfaceDismiss')}
                  iconOnly
                  onClick={() => store.worktree.patch(sessionId, { phase: 'idle', error: '' })}
                  title={locale.text('surfaceDismiss')}
                >
                  <Icon as={Xmark} size={14} />
                </ConversationBarAction>
              )}
            </>
          )}
          data-dsh-worktree-surface={sessionId}
          error={failed ? state.error : undefined}
          glyph={<Icon as={CircleTree} size={14} />}
          label={`${label}${creating ? '...' : ''}`}
        >
          {bound && state.log.length > 0 && (
            <ConversationBarAction
              aria-label={locale.text('progressViewLogs')}
              iconOnly
              onClick={() => setLogOpen(value => !value)}
              title={locale.text('progressViewLogs')}
            >
              <Icon as={TerminalLine} size={14} />
            </ConversationBarAction>
          )}
        </ConversationBar>
        {logOpen && <Logs log={state.log} open={logOpen} />}
      </div>
    </div>
  )
}

export function Logs({ log, open }: { log: readonly string[], open: boolean }): ReactElement {
  const occurrences = new Map<string, number>()
  return (
    <div
      aria-hidden={!open}
      className={cn(
        'grid grid-rows-[0fr] opacity-0 [transition:grid-template-rows_180ms_cubic-bezier(.16,1,.3,1),opacity_140ms_ease]',
        open && 'grid-rows-[1fr] opacity-100',
      )}
    >
      <div className="min-h-0 overflow-hidden mt-[6px]">
        <div className="max-h-[180px] overflow-y-auto p-[10px] rounded-[10px] border border-border-l2 bg-[var(--dsw-alias-bg-base)] z-30">
          {log.map((line) => {
            const occurrence = occurrences.get(line) ?? 0
            occurrences.set(line, occurrence + 1)
            return <div key={JSON.stringify([line, occurrence])} className="text-[12px] leading-[16px] [font-family:cursive]">{line}</div>
          })}
        </div>
      </div>
    </div>
  )
}
