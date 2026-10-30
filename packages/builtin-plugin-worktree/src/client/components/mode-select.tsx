import type { ReactElement } from 'react'
import type { ConversationAttachments, DraftAttachmentDescriptor } from '../service/attachments.types'
import type { InputActions, InputState, SessionInputRuntime, SessionsRuntime, WorkspacesRuntime } from '../service/session-switch.types'
import { ChevronDown, Chip, CircleTree, Icon, Menu } from 'dsh-tauri-ui/client'
import { forEach, get } from 'dsh-tauri/client'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  COMPOSER_MODE_BUTTON_SELECTOR,
  COMPOSER_PLAN_SLOT_SELECTOR,
  COMPOSER_SEAT_SELECTOR,
  HERO_PRESET_SLOT_SELECTOR,
  MODE_ANCHOR_ATTRIBUTE,
} from '../constants'
import { useWaiter } from '../hooks/use-waiter'
import { useWorktreeSession } from '../hooks/use-worktree-session'
import { locale } from '../locales'
import { awaitDraftUploads, captureDraftAttachments, mergeCapturedAttachments, recreateDraftAttachments, releaseDraftAttachments } from '../service/attachments'
import { waitForInputActions, waitForSessionListed } from '../service/session-switch'
import { attach, create } from '../service/worktree'
import { store } from '../store'
import { addDraftAttachments, canAddDraftAttachments, draftAttachmentIds, hasSendableContent, interceptsSubmit, removeDraftAttachment, resolveAccessModeGroup, restoreSessionDraft, showsModeSelect } from './mode-select.utils'

export interface ModeSelectProps {
  sessionId: string
  useInput: <S>(selector: (state: InputState) => S) => S
  inputActions: InputActions
  sessionsRuntime: SessionsRuntime
  workspacesRuntime: WorkspacesRuntime
  resolveAttachments: () => ConversationAttachments | undefined
  resolveInput?: (sessionId: string) => SessionInputRuntime | undefined
}

export function WorktreeModeSelect(props: ModeSelectProps): ReactElement {
  const { sessionId } = props
  const anchorRef = useRef<HTMLSpanElement>(null)
  const portalHostRef = useRef<HTMLSpanElement | null>(null)

  // keep:effect composer 锚点由组件 ref 决定，DOM 重排观察无法上提到 register
  const subscribe = useCallback((onChange: () => void) => {
    const anchor = anchorRef.current
    const composerSeat = anchor?.closest<HTMLElement>(COMPOSER_SEAT_SELECTOR)
    if (!composerSeat)
      return () => {}

    let host: HTMLSpanElement | null = null
    const place = (): void => {
      const modeButton = composerSeat.querySelector<HTMLElement>(COMPOSER_MODE_BUTTON_SELECTOR)
      let target: HTMLElement | null = null
      if (modeButton) {
        const planSlot = composerSeat.querySelector<HTMLElement>(COMPOSER_PLAN_SLOT_SELECTOR)
        target = resolveAccessModeGroup(modeButton, planSlot)
      }
      target ??= composerSeat.querySelector<HTMLElement>(HERO_PRESET_SLOT_SELECTOR)
      if (!target) {
        host?.remove()
        host = null
      }
      else {
        if (!host) {
          host = document.createElement('span')
          host.dataset.dshTauriWorktreeMode = sessionId
          host.className = 'inline-flex items-center flex-none'
        }
        if (target.nextElementSibling !== host)
          target.after(host)
      }
      portalHostRef.current = host
      onChange()
    }

    place()
    const observer = new MutationObserver(place)
    observer.observe(composerSeat, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      host?.remove()
      portalHostRef.current = null
    }
  }, [sessionId])
  const portalHost = useSyncExternalStore(subscribe, () => portalHostRef.current, () => null)

  return (
    <>
      <span ref={anchorRef} className="hidden" {...{ [MODE_ANCHOR_ATTRIBUTE]: sessionId }} />
      {portalHost && createPortal(<WorktreeModeControl {...props} />, portalHost)}
    </>
  )
}

function WorktreeModeControl({ sessionId, useInput, inputActions, sessionsRuntime, workspacesRuntime, resolveAttachments, resolveInput }: ModeSelectProps): ReactElement | null {
  const state = useWorktreeSession(sessionId)
  const draft = useInput(input => input.draft)
  const attachmentIds = useInput(draftAttachmentIds)
  const { wait } = useWaiter()
  locale.useLocale()
  const [open, setOpen] = useState(false)
  const submittingRef = useRef(false)
  const capturedRef = useRef<readonly DraftAttachmentDescriptor[]>([])
  const sendable = hasSendableContent(draft, attachmentIds)

  // keep:effect 附件本体必须尽早抓：会话作用域随时可能重新物化，对象一被释放就只剩死 id。
  useEffect(() => {
    if (attachmentIds.length === 0) {
      capturedRef.current = []
      return
    }
    capturedRef.current = mergeCapturedAttachments(
      captureDraftAttachments(resolveAttachments(), attachmentIds),
      capturedRef.current,
      attachmentIds,
    )
  }, [attachmentIds, resolveAttachments])

  // keep:effect 发送拦截依赖官方 composer 私有 DOM，没有 pre-submit 钩子可用
  useEffect(() => {
    if (!interceptsSubmit({ isGit: state.isGit, mode: state.mode }))
      return
    const root = document.querySelector<HTMLElement>(`[${MODE_ANCHOR_ATTRIBUTE}="${CSS.escape(sessionId)}"]`)
    const composerSeat = root?.closest<HTMLElement>(COMPOSER_SEAT_SELECTOR)
    if (!composerSeat)
      return

    const start = async (): Promise<void> => {
      if (submittingRef.current || !sendable)
        return
      const currentDraft = resolveInput?.(sessionId)?.draftSnapshot
      if (typeof inputActions.persistDraft === 'function' && currentDraft === undefined) {
        store.worktree.patch(sessionId, { mode: 'local', phase: 'error', loadingLabel: '', error: '无法读取消息引用草稿，请重试' })
        return
      }
      submittingRef.current = true
      const capturedDraft = currentDraft === undefined
        ? { text: draft, references: [] }
        : { text: currentDraft.text, references: currentDraft.references.map(reference => ({ ...reference })) }
      const conversation = resolveAttachments()
      const captured = mergeCapturedAttachments(
        captureDraftAttachments(conversation, attachmentIds),
        capturedRef.current,
        attachmentIds,
      )
      const targetSessionId = `session-${crypto.randomUUID()}`
      store.worktree.patch(sessionId, { mode: 'pending', phase: 'creating', loadingLabel: locale.text('progressCreating'), error: '' })
      let switched = false
      let detached = false
      let recreated: readonly { id: string }[] = []
      let nextActions: InputActions | undefined
      try {
        const created = await create({ sessionId: targetSessionId, sourceSessionId: sessionId, inherit: true })
        if (!created.ok || !created.result)
          throw new Error(created.error ?? 'Failed to create worktree.')
        const result = created.result
        const worktreePath = result.worktreePath
        if (!worktreePath)
          throw new Error('Failed to create worktree.')
        if (result.inherited !== true)
          throw new Error(locale.text('inheritanceFailed'))
        await waitForSessionListed({ sessions: sessionsRuntime, sessionId: targetSessionId, wait })
        await attach({ sessionId: targetSessionId })
        if (attachmentIds.length > 0 && !canAddDraftAttachments(inputActions))
          throw new Error('无法迁移消息附件到工作树会话')
        inputActions.setDraft('')
        inputActions.persistDraft?.()
        forEach(attachmentIds, attachmentId => removeDraftAttachment(inputActions, attachmentId))
        detached = true
        sessionsRuntime.open(targetSessionId)
        switched = true
        releaseDraftAttachments(conversation, captured)
        const actions = await waitForInputActions({ sessions: sessionsRuntime, sessionId: targetSessionId, wait })
        nextActions = actions
        restoreSessionDraft(actions, capturedDraft, resolveInput?.(targetSessionId))
        const rebuilt = recreateDraftAttachments(conversation, targetSessionId, captured)
        recreated = rebuilt.drafts
        if (rebuilt.ids.length !== captured.length)
          throw new Error('无法迁移消息附件到工作树会话')
        const capturedIds = new Set(captured.map(value => value.id))
        const targetAttachmentIds = [
          ...rebuilt.ids,
          ...attachmentIds.filter(id => !capturedIds.has(id)),
        ]
        if (targetAttachmentIds.length > 0 && !addDraftAttachments(actions, targetAttachmentIds))
          throw new Error('无法迁移消息附件到工作树会话')
        await awaitDraftUploads({ conversation, ids: [...rebuilt.ids], wait })
        store.worktree.patch(sessionId, { mode: 'local', phase: 'idle', loadingLabel: '' })
        queueMicrotask(() => {
          try {
            actions.submit()
          }
          finally {
            actions.setDraft('')
            actions.persistDraft?.()
            forEach(targetAttachmentIds, attachmentId => removeDraftAttachment(actions, attachmentId))
          }
        })
        await workspacesRuntime.archiveSession(sessionId).catch(() => {})
      }
      catch (error) {
        const message = get(error, 'message', String(error))
        let restored = !switched
        if (detached && switched) {
          nextActions?.setDraft('')
          nextActions?.persistDraft?.()
          try {
            sessionsRuntime.open(sessionId)
            const sourceActions = await waitForInputActions({ sessions: sessionsRuntime, sessionId, wait })
            releaseDraftAttachments(conversation, recreated)
            restoreSessionDraft(sourceActions, capturedDraft, resolveInput?.(sessionId))
            const back = recreateDraftAttachments(conversation, sessionId, captured)
            const complete = back.ids.length === captured.length
            const added = addDraftAttachments(sourceActions, [...back.ids, ...attachmentIds.filter(id => !captured.some(value => value.id === id))])
            restored = complete && added
          }
          catch {
            restored = false
          }
        }
        else if (detached) {
          try {
            restoreSessionDraft(inputActions, capturedDraft, resolveInput?.(sessionId))
            const back = recreateDraftAttachments(conversation, sessionId, captured)
            restored = back.ids.length === captured.length
              && addDraftAttachments(inputActions, [...back.ids, ...attachmentIds.filter(id => !captured.some(value => value.id === id))])
          }
          catch {
            restored = false
          }
        }
        store.worktree.patch(sessionId, {
          mode: 'local',
          phase: 'error',
          loadingLabel: '',
          error: message,
        })
        if (!restored) {
          store.worktree.patch(targetSessionId, {
            mode: 'local',
            phase: 'error',
            loadingLabel: '',
            error: message,
          })
        }
      }
      finally {
        submittingRef.current = false
      }
    }

    const intercept = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Node) || !composerSeat.contains(target))
        return
      if (event instanceof MouseEvent) {
        const button = target instanceof Element ? target.closest('button[aria-label]') : null
        if (button?.getAttribute('aria-label')?.includes('发送') !== true && button?.getAttribute('aria-label')?.toLowerCase().includes('send') !== true)
          return
      }
      if (event instanceof KeyboardEvent && (event.key !== 'Enter' || event.shiftKey || event.isComposing))
        return
      if (!sendable)
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      void start()
    }

    composerSeat.addEventListener('click', intercept, true)
    composerSeat.addEventListener('keydown', intercept, true)
    return () => {
      composerSeat.removeEventListener('click', intercept, true)
      composerSeat.removeEventListener('keydown', intercept, true)
    }
  }, [draft, attachmentIds, inputActions, resolveAttachments, resolveInput, sendable, sessionId, sessionsRuntime, state.isGit, state.mode, wait, workspacesRuntime])

  if (!showsModeSelect(state))
    return null

  const pending = state.mode === 'pending'
  const activeLabel = pending ? locale.text('modeNewWorktree') : locale.text('modeLocal')
  const trigger = (
    <Chip
      variant="composerTrigger"
      aria-label={locale.text('modeLabel')}
      aria-haspopup="menu"
      aria-expanded={open}
      open={open}
      icon={<Icon as={CircleTree} size={14} />}
      chevron={<Icon as={ChevronDown} />}
      onClick={() => setOpen(value => !value)}
    >
      <span className="min-w-0 truncate">{activeLabel}</span>
    </Chip>
  )

  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={[
        { id: 'local', label: locale.text('modeLocal') },
        { id: 'pending', label: locale.text('modeWorktree') },
      ]}
      selectedId={pending ? 'pending' : 'local'}
      onSelect={(id) => {
        setOpen(false)
        const mode = id === 'pending' ? 'pending' : 'local'
        store.worktree.patch(sessionId, {
          mode,
          phase: 'idle',
          loadingLabel: '',
          error: '',
        })
      }}
      side="top"
      align="start"
      portal
      anchor={trigger}
    />
  )
}
