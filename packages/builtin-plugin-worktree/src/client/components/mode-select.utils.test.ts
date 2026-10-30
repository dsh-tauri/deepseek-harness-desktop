import type { WorktreeSessionState } from '../store/modules/worktree.types'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_STATE } from '../store/modules/worktree.utils'
import {
  addDraftAttachments,
  canAddDraftAttachments,
  draftAttachmentIds,
  hasSendableContent,
  interceptsSubmit,
  NO_DRAFT_ATTACHMENTS,
  removeDraftAttachment,
  resolveAccessModeGroup,
  showsModeSelect,
} from './mode-select.utils'

function sessionState(patch: Partial<WorktreeSessionState> = {}): WorktreeSessionState {
  return { ...EMPTY_SESSION_STATE, ...patch }
}

describe('工作树模式选择框的可见性与发送拦截（issue #648）', () => {
  it('未校准的会话不得把 isGit 当成 true，未知或非 git 都不渲染控件', () => {
    expect(EMPTY_SESSION_STATE.isGit).toBeNull()
    expect(sessionState().isGit).toBeNull()
    expect(showsModeSelect(sessionState({ isGit: null }))).toBe(false)
    expect(showsModeSelect(sessionState({ isGit: false }))).toBe(false)
    expect(showsModeSelect(sessionState({ isGit: null, mode: 'pending' }))).toBe(false)
  })

  it('只有在确认为 git 且未处于工作树模式时才渲染控件', () => {
    expect(showsModeSelect(sessionState({ isGit: true, mode: 'local' }))).toBe(true)
    expect(showsModeSelect(sessionState({ isGit: true, mode: 'pending' }))).toBe(true)
    expect(showsModeSelect(sessionState({ isGit: true, mode: 'worktree' }))).toBe(false)
  })

  it('拦截条件与渲染条件一致：控件不显示就绝不吞发送事件', () => {
    for (const isGit of [null, false]) {
      const state = sessionState({ isGit, mode: 'pending' })
      expect(showsModeSelect(state)).toBe(false)
      expect(interceptsSubmit(state)).toBe(false)
    }
  })

  it('仅本地/待建工作树的已校准会话拦截发送', () => {
    expect(interceptsSubmit(sessionState({ isGit: true, mode: 'pending' }))).toBe(true)
    expect(interceptsSubmit(sessionState({ isGit: true, mode: 'local' }))).toBe(false)
    expect(interceptsSubmit(sessionState({ isGit: true, mode: 'worktree' }))).toBe(false)
  })
})

describe('hasSendableContent', () => {
  it('有正文即可发送', () => {
    expect(hasSendableContent('hi', [])).toBe(true)
    expect(hasSendableContent('  hi  ', [])).toBe(true)
  })

  it('纯附件（截图/文件、无正文）同样可发送：核心认这种发送，漏判会把它放回本地会话', () => {
    expect(hasSendableContent('', ['a'])).toBe(true)
    expect(hasSendableContent('   ', ['a'])).toBe(true)
  })

  it('既没有正文也没有附件时不可发送，拦截器必须放行', () => {
    expect(hasSendableContent('', [])).toBe(false)
    expect(hasSendableContent('  \n ', [])).toBe(false)
  })
})

describe('draftAttachmentIds', () => {
  it('prefers the alpha attachmentIds field', () => {
    expect(draftAttachmentIds({ draft: '', attachmentIds: ['a'] })).toEqual(['a'])
  })

  it('falls back to the legacy imageIds field', () => {
    expect(draftAttachmentIds({ draft: '', imageIds: ['b'] })).toEqual(['b'])
  })

  it('returns a stable empty array when neither field is present', () => {
    const first = draftAttachmentIds({ draft: '' })
    const second = draftAttachmentIds(undefined)
    expect(first).toBe(NO_DRAFT_ATTACHMENTS)
    expect(second).toBe(NO_DRAFT_ATTACHMENTS)
    expect(first.length).toBe(0)
  })
})

describe('addDraftAttachments', () => {
  it('uses addAttachments when the alpha action face is present', () => {
    const addAttachments = vi.fn(() => true)
    const addImages = vi.fn(() => true)
    expect(addDraftAttachments({ setDraft: vi.fn(), submit: vi.fn(), addAttachments, addImages }, ['a'])).toBe(true)
    expect(addAttachments).toHaveBeenCalledWith(['a'])
    expect(addImages).not.toHaveBeenCalled()
  })

  it('uses the legacy addImages action when addAttachments is absent', () => {
    const addImages = vi.fn(() => true)
    expect(addDraftAttachments({ setDraft: vi.fn(), submit: vi.fn(), addImages }, ['a'])).toBe(true)
    expect(addImages).toHaveBeenCalledWith(['a'])
  })

  it('is a no-op success without attachments and a failure when the action face is missing', () => {
    expect(addDraftAttachments({ setDraft: vi.fn(), submit: vi.fn() }, [])).toBe(true)
    expect(addDraftAttachments({ setDraft: vi.fn(), submit: vi.fn() }, ['a'])).toBe(false)
    expect(addDraftAttachments(undefined, ['a'])).toBe(false)
  })
})

describe('canAddDraftAttachments', () => {
  it('识别两代可写的附件面，缺一面即不可写', () => {
    expect(canAddDraftAttachments({ setDraft: vi.fn(), submit: vi.fn(), addAttachments: vi.fn() })).toBe(true)
    expect(canAddDraftAttachments({ setDraft: vi.fn(), submit: vi.fn(), addImages: vi.fn() })).toBe(true)
    expect(canAddDraftAttachments({ setDraft: vi.fn(), submit: vi.fn() })).toBe(false)
    expect(canAddDraftAttachments(undefined)).toBe(false)
  })
})

describe('removeDraftAttachment', () => {
  it('prefers removeAttachment over the legacy removeImage', () => {
    const removeAttachment = vi.fn()
    const removeImage = vi.fn()
    removeDraftAttachment({ setDraft: vi.fn(), submit: vi.fn(), removeAttachment, removeImage }, 'a')
    expect(removeAttachment).toHaveBeenCalledWith('a')
    expect(removeImage).not.toHaveBeenCalled()
  })

  it('falls back to removeImage and tolerates a missing action face', () => {
    const removeImage = vi.fn()
    removeDraftAttachment({ setDraft: vi.fn(), submit: vi.fn(), removeImage }, 'a')
    expect(removeImage).toHaveBeenCalledWith('a')
    expect(() => removeDraftAttachment(undefined, 'a')).not.toThrow()
  })
})

interface NodeStub {
  parentElement: NodeStub | null
  contains: (other: unknown) => boolean
}

function buildModesSkeleton(): { modes: NodeStub, menuRoot: NodeStub, button: NodeStub, planSlot: NodeStub } {
  const modes: NodeStub = { parentElement: null, contains: () => false }
  const menuRoot: NodeStub = { parentElement: modes, contains: () => false }
  const button: NodeStub = { parentElement: menuRoot, contains: () => false }
  const planSlot: NodeStub = { parentElement: modes, contains: () => false }
  modes.contains = other => other === planSlot || other === menuRoot
  return { modes, menuRoot, button, planSlot }
}

describe('resolveAccessModeGroup', () => {
  it('从访问模式按钮向上定位到包含 plan 槽位的 .modes 分组（而非 Menu root span）', () => {
    const { modes, button, planSlot } = buildModesSkeleton()
    const target = resolveAccessModeGroup(button as unknown as HTMLElement, planSlot as unknown as Element)
    expect(target).toBe(modes as unknown as HTMLElement)
  })

  it('plan 槽位缺失（alpha 变体）时退回 Menu root span 的父节点', () => {
    const { modes, button } = buildModesSkeleton()
    const target = resolveAccessModeGroup(button as unknown as HTMLElement, null)
    expect(target).toBe(modes as unknown as HTMLElement)
  })

  it('按钮悬浮（向上链路断）时回退返回按钮本身，控件不消失', () => {
    const button: NodeStub = { parentElement: null, contains: () => false }
    const target = resolveAccessModeGroup(button as unknown as HTMLElement, null)
    expect(target).toBe(button as unknown as HTMLElement)
  })

  it('超过 maxDepth 仍未命中时回退返回按钮本身', () => {
    const { button, planSlot } = buildModesSkeleton()
    const target = resolveAccessModeGroup(button as unknown as HTMLElement, planSlot as unknown as Element, 1)
    expect(target).toBe(button as unknown as HTMLElement)
  })
})
