import type { DraftReference, InputActions, SessionInputRuntime } from '../service/session-switch.types'
import { describe, expect, it, vi } from 'vitest'
import { restoreSessionDraft } from './mode-select.utils'

const references: readonly DraftReference[] = [
  { source: 'files', ref: '/a.ts', offset: 4, length: 5, label: 'a.ts', appearance: 'file', clipboardText: '/a.ts' },
  { source: 'sessions', ref: 'previous', offset: 14, length: 9, label: 'previous', appearance: 'session', clipboardText: '@previous' },
]
const draft = { text: 'see /a.ts and @previous', references }

function surface() {
  const actions: InputActions = { setDraft: vi.fn(), persistDraft: vi.fn(), submit: vi.fn() }
  const input: SessionInputRuntime = {
    draftSnapshot: { text: '', references: [] },
    setDraft: vi.fn(),
  }
  return { actions, input }
}

describe('worktree session draft restoration', () => {
  it('restores file and session references as one semantic document without changing their spans', () => {
    const { actions, input } = surface()
    restoreSessionDraft(actions, draft, input)
    expect(input.setDraft).toHaveBeenCalledExactlyOnceWith(draft)
    expect(actions.setDraft).not.toHaveBeenCalled()
    expect(actions.persistDraft).toHaveBeenCalledOnce()
    expect(actions.submit).not.toHaveBeenCalled()
  })

  it('keeps plain-text restoration available on kernels without reference or persistence actions', () => {
    const actions = { setDraft: vi.fn(), submit: vi.fn() }
    restoreSessionDraft(actions, { text: 'plain text', references: [] })
    expect(actions.setDraft).toHaveBeenCalledExactlyOnceWith('plain text')
    expect(actions.submit).not.toHaveBeenCalled()
  })

  it('refuses to replace content when the target has no reference input', () => {
    const { actions } = surface()
    expect(() => restoreSessionDraft(actions, draft)).toThrow('无法迁移消息引用到工作树会话')
    expect(actions.setDraft).not.toHaveBeenCalled()
    expect(actions.persistDraft).not.toHaveBeenCalled()
  })

  it('propagates a failed semantic import without persisting or submitting a partial draft', () => {
    const { actions, input } = surface()
    vi.mocked(input.setDraft).mockImplementationOnce(() => {
      throw new Error('disposed input')
    })
    expect(() => restoreSessionDraft(actions, draft, input)).toThrow('disposed input')
    expect(input.setDraft).toHaveBeenCalledOnce()
    expect(actions.persistDraft).not.toHaveBeenCalled()
    expect(actions.submit).not.toHaveBeenCalled()
  })
})
