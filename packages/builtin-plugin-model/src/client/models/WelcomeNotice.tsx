import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import type { WelcomeNoticeState, WelcomeNoticeStore } from './welcome-store.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef } from 'react'
import { OnboardingModal } from './OnboardingModal.tsx'
import { welcomeStyles as css } from './styles.ts'

export interface WelcomeNoticeInjected {
  hooks: {
    welcome: SnapshotStore<WelcomeNoticeState>
  }

  controller: WelcomeNoticeStore

  t: (key: keyof typeof en) => string
}

export type WelcomeNoticeProps
  = PropsRuntime<'settings.onboarding'> & InjectFace<WelcomeNoticeInjected>

export function WelcomeNotice(props: WelcomeNoticeProps): ReactNode {
  const { complete, controller, useWelcome, t } = props
  const state = useWelcome(snapshot => snapshot)
  const finishedRef = useRef(false)
  const finish = useCallback((): void => {
    if (finishedRef.current)
      return
    finishedRef.current = true
    complete()
  }, [complete])

  useEffect(() => {
    if (state.status === 'idle')
      void controller.load()
  }, [controller, state.status])

  useEffect(() => {
    if (state.acknowledged)
      finish()
  }, [finish, state.acknowledged])

  if (state.status === 'idle' || state.status === 'loading' || state.acknowledged)
    return null

  const acknowledge = async (): Promise<void> => {
    if (await controller.acknowledge())
      finish()
  }
  const paragraphs = t('welcomeBody').split('\n\n')

  return (
    <OnboardingModal title={t('welcomeTitle')} focusTitle>
      <div className={css.copy}>
        {paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
      </div>
      {state.error === null ? null : <p className={css.error} role="alert">{t('welcomeError')}</p>}
      <div className={css.actions}>
        <Button
          variant="primary"
          className={css.primary}
          disabled={state.status === 'saving'}
          onClick={() => { void acknowledge() }}
        >
          {t('welcomeContinue')}
        </Button>
      </div>
    </OnboardingModal>
  )
}
