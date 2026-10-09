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
  // 部分解析也要与早先那份按 id 合并——已经释放的对象再也抓不回来，替换掉等于丢附件。
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
      // 关键一步：在**任何 await 之前**拿到附件本体。建工作树要几秒，期间会话作用域会重新物化，
      // 附件对象随即被释放（只剩死 id）——正文有持久化兜底，附件没有；现场抓一次，再与早先抓到的按 id 合并。
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
        if (result.inherited) {
          await waitForSessionListed({ sessions: sessionsRuntime, sessionId: targetSessionId, wait })
        }
        else {
          await sessionsRuntime.create({ cwd: worktreePath, sessionId: targetSessionId })
        }
        await attach({ sessionId: targetSessionId })
        // 目标输入面只在切换后才物化，而源附件一旦摘除、源作用域随切换销毁就再也回不去：
        // 先用源输入面探测该核心的附件面是否可写，不可写就整体中止（此时草稿与附件都还没动）。
        if (attachmentIds.length > 0 && !canAddDraftAttachments(inputActions))
          throw new Error('无法迁移消息附件到工作树会话')
        // 0.1.6 起会话输入面只在被保留的会话上物化：先切换（切换即保留主视图）再取目标输入面。
        // 源会话的草稿与附件必须先摘除——源作用域随切换销毁，会把仍挂在其草稿上的附件从注册表释放。
        inputActions.setDraft('')
        inputActions.persistDraft?.()
        forEach(attachmentIds, attachmentId => removeDraftAttachment(inputActions, attachmentId))
        detached = true
        sessionsRuntime.open(targetSessionId)
        switched = true
        // 切换成功后才回收源侧本体：切换失败时回滚路径还要靠它们把附件放回源会话。
        releaseDraftAttachments(conversation, captured)
        const actions = await waitForInputActions({ sessions: sessionsRuntime, sessionId: targetSessionId, wait })
        nextActions = actions
        restoreSessionDraft(actions, capturedDraft, resolveInput?.(targetSessionId))
        // 用抓到的本体在目标会话重建附件（新 id、新上传，凭证天然归属目标会话）；抓不到的旧 id 交给目标侧 prune 兜底。
        const rebuilt = recreateDraftAttachments(conversation, targetSessionId, captured)
        recreated = rebuilt.drafts
        // 重建不齐就得整体中止：静默少带附件比失败回滚更糟，用户会以为发出去了（已建的先记下来供回滚回收）。
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
        if (result.inherited)
          await workspacesRuntime.archiveSession(sessionId).catch(() => {})
      }
      catch (error) {
        const message = get(error, 'message', String(error))
        // 切换前的失败源会话仍在：把已摘除的草稿与附件放回即可。
        // 切换后的失败无法就地恢复：切回源会话，用它重新物化的输入面放回内容，避免用户丢内容。
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
            // 放回也必须完整：重建不齐时不能对外声称已恢复（内容确实少了一部分）。
            const complete = back.ids.length === captured.length
            const added = addDraftAttachments(sourceActions, [...back.ids, ...attachmentIds.filter(id => !captured.some(value => value.id === id))])
            restored = complete && added
          }
          catch {
            restored = false
          }
        }
        else if (detached) {
          // 没切过去（源会话仍在当前视图）：用本体在源会话重建，避免源侧对象已被释放时把死 id 放回草稿。
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
        // 失败必须退回 local：停在 pending 会让拦截器一直吞掉发送事件，会话彻底不可用。
        store.worktree.patch(sessionId, {
          mode: 'local',
          phase: 'error',
          loadingLabel: '',
          error: message,
        })
        // 没能切回源会话时源提示条不再渲染：错误同步到当前会话，避免静默失败。
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
      // 没有正文也没有附件就没什么可接管的，放行；吞掉事件却什么都不做，等价于把发送键焊死。
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
