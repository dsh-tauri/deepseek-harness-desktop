import type { ClientContext } from 'dsh-tauri/client'
import type { ComposerIconState, ComposerSessionBinding, ComposerSessionSnapshot, ComposerSessionsRuntime } from './composer-resume.types'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { locale } from '../locales'
import { resumeComposer } from '../service/composer-resume'
import {
  isComposerEmpty,
  isContentRiskTurnEnd,
  paintResumeIcon,
  primaryButtonOf,
  readIconPath,
  restoreDisabled,
  restorePrimaryIcon,
  shouldOfferResume,
} from './composer-resume.utils'

const COMPOSER_CARD_SELECTOR = '[data-composer-card]'

export const composerResumeFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  if (typeof document === 'undefined')
    return

  const sessions = adapter.sessions as ComposerSessionsRuntime
  const sessionsList = sessions.list
  const sessionsBinding = sessions.binding
  if (sessionsList === undefined || sessionsBinding === undefined)
    return

  let binding: ComposerSessionBinding | undefined
  let watchedSessionId: string | undefined
  let unwatchEvents: (() => void) | undefined
  let unwatchSession: (() => void) | undefined
  let patch: { button: HTMLButtonElement, icon: ComposerIconState } | undefined
  let pending = false

  // 审核失败不给普通「继续」：同一会话重放被拒上下文只会再次 400，按钮必须写明
  // 会改写历史。文案从实时快照现算，任何缓存都会在切会话后说错话。
  const resumeLabel = (): string => locale.text(isContentRiskTurnEnd(binding?.eventSource?.getSnapshot?.().entries) ? 'recoverContentRisk' : 'resumeTask')

  const snapshotNow = (): ComposerSessionSnapshot | undefined => binding?.session?.getSnapshot?.()

  const sessionIdNow = (): string | undefined => sessionsList.getSnapshot().current

  const bindingOf = (sessionId: string): ComposerSessionBinding | undefined => {
    const resolved = sessionsBinding(sessionId)
    return typeof resolved === 'object' && resolved !== null ? resolved as ComposerSessionBinding : undefined
  }

  function restore(card?: Element | null): void {
    const current = patch
    if (current === undefined)
      return
    patch = undefined
    const anchor = card ?? document.querySelector(COMPOSER_CARD_SELECTOR)
    const snapshot = snapshotNow()
    const disabled = anchor !== null && restoreDisabled(
      isComposerEmpty(anchor),
      snapshot?.running === true,
      snapshot?.subagent !== null && snapshot?.subagent !== undefined,
    )
    restorePrimaryIcon(current.button, current.icon, { label: resumeLabel(), disabled })
  }

  function paint(button: HTMLButtonElement): void {
    if (patch?.button !== button) {
      const path = readIconPath(button)
      if (path === null) {
        button.disabled = false
        return
      }
      restore()
      patch = { button, icon: { path, ariaLabel: button.getAttribute('aria-label') } }
    }
    paintResumeIcon(button, resumeLabel())
  }

  function reconcile(): void {
    if (controller.isDisposed())
      return
    const card = document.querySelector(COMPOSER_CARD_SELECTOR)
    const entries = binding?.eventSource?.getSnapshot?.().entries
    if (card !== null && isComposerEmpty(card) && shouldOfferResume({ session: snapshotNow(), entries })) {
      const button = primaryButtonOf(card)
      if (button !== null) {
        paint(button)
        return
      }
    }
    restore(card)
  }

  function unwatch(): void {
    unwatchEvents?.()
    unwatchEvents = undefined
    unwatchSession?.()
    unwatchSession = undefined
  }

  function refresh(): void {
    const sessionId = sessionIdNow()
    if (sessionId !== watchedSessionId) {
      watchedSessionId = sessionId
      unwatch()
      const next = sessionId === undefined ? undefined : bindingOf(sessionId)
      if (typeof next?.eventSource?.subscribe === 'function')
        unwatchEvents = next.eventSource.subscribe(reconcile)
      if (typeof next?.session?.subscribe === 'function')
        unwatchSession = next.session.subscribe(reconcile)
    }
    binding = sessionId === undefined ? undefined : bindingOf(sessionId)
    reconcile()
  }

  async function resume(): Promise<void> {
    const sessionId = sessionIdNow()
    if (sessionId === undefined || pending)
      return
    pending = true
    const outcome = await resumeComposer({ sessionId })
    pending = false
    if (!outcome.ok) {
      console.warn(`[${PLUGIN_ID}] 会话继续失败: ${outcome.error ?? 'unknown'}`)
      reconcile()
    }
  }

  controller.add(sessionsList.subscribe(refresh))
  controller.add(ctx.locale.subscribe(() => {
    if (patch !== undefined)
      paintResumeIcon(patch.button, resumeLabel())
  }))
  controller.add(unwatch)
  controller.listen('click', (event) => {
    if (patch === undefined)
      return
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (button !== patch.button)
      return
    event.preventDefault()
    event.stopPropagation()
    void resume()
  }, { capture: true })
  controller.observe(document.body, () => reconcile(), {
    attributeFilter: ['d', 'disabled'],
    attributes: true,
    childList: true,
    subtree: true,
  })

  refresh()
})
