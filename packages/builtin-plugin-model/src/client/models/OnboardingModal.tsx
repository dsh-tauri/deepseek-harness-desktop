import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef } from 'react'
import { onboardingStyles as css } from './styles.ts'

function ignoreImplicitDismiss(): void {}

export function OnboardingModal({
  title,
  focusTitle = false,
  children,
}: {
  title: string
  focusTitle?: boolean
  children: ReactNode
}): ReactNode {
  const titleRef = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    const appRoot = document.getElementById('root')
    if (appRoot === null)
      return
    const previous = appRoot.inert
    appRoot.inert = true
    return () => {
      appRoot.inert = previous
    }
  }, [])

  useEffect(() => {
    if (focusTitle)
      titleRef.current?.focus()
  }, [focusTitle])

  return (
    <Modal
      open
      title={title}
      onClose={ignoreImplicitDismiss}
      headless
      className={css.dialog as string}
    >
      <div className={css.content}>
        <h2 ref={titleRef} className={css.title} tabIndex={focusTitle ? -1 : undefined}>{title}</h2>
        <div className={css.body}>{children}</div>
      </div>
    </Modal>
  )
}
