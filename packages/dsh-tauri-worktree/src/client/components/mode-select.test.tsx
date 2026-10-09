// @vitest-environment jsdom
import type { ReactNode } from 'react'
import type { SessionInputRuntime } from '../service/session-switch.types'
import type { ModeSelectProps } from './mode-select'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attach, create } from '../service/worktree'
import { store } from '../store'
import { WorktreeModeSelect } from './mode-select'

vi.mock('dsh-tauri-ui/client', () => ({
  Chip: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  Menu: ({ anchor }: { anchor: ReactNode }) => anchor,
  Icon: () => null,
  ChevronDown: () => null,
  CircleTree: () => null,
}))
vi.mock('dsh-tauri/client', async () => {
  const { forEach, get } = await import('lodash-es')
  return { forEach, get }
})
const worktreeState = vi.hoisted(() => ({ isGit: true, mode: 'local' }))
vi.mock('../hooks/use-worktree-session', () => ({ useWorktreeSession: () => worktreeState }))
vi.mock('../hooks/use-waiter', () => ({ useWaiter: () => ({ mountedRef: { current: true }, wait: vi.fn() }) }))
vi.mock('../locales', () => ({ locale: { text: (key: string) => key, useLocale: () => 'en' } }))
vi.mock('../store', () => ({ store: { worktree: { patch: vi.fn() } } }))
vi.mock('../service/worktree', () => ({ attach: vi.fn(), create: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^\w-]/g, '\\$&') })
  worktreeState.mode = 'local'
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function transferSurface() {
  worktreeState.mode = 'pending'
  const draft = {
    text: 'see /a.ts, then @previous\n',
    references: [
      { source: 'files', ref: '/a.ts', offset: 4, length: 5, label: 'a.ts', clipboardText: '/a.ts', appearance: 'file' as const },
      { source: 'sessions', ref: 'previous', offset: 16, length: 9, label: 'previous', clipboardText: '@previous', appearance: 'session' as const, invalid: true },
    ],
  }
  const sourceActions = { setDraft: vi.fn(), persistDraft: vi.fn(), submit: vi.fn() }
  const targetActions = { setDraft: vi.fn(), persistDraft: vi.fn(), submit: vi.fn() }
  const sourceInput: SessionInputRuntime = { draftSnapshot: draft, setDraft: vi.fn() }
  const targetInput: SessionInputRuntime = { draftSnapshot: { text: '', references: [] }, setDraft: vi.fn() }
  let current = 'source'
  vi.mocked(create).mockResolvedValue({ ok: true, result: { worktreePath: '/scratch/worktree', inherited: false } } as Awaited<ReturnType<typeof create>>)
  vi.mocked(attach).mockResolvedValue({ ok: true })
  const props: ModeSelectProps = {
    sessionId: 'source',
    useInput(selector) {
      const [input] = useState({ draft: draft.text })
      return selector(input)
    },
    inputActions: sourceActions,
    sessionsRuntime: {
      create: vi.fn(async options => options.sessionId),
      open(id) { current = id },
      refresh: vi.fn(async () => {}),
      list: { getSnapshot: () => ({ ids: [current], current }), subscribe: () => () => {} },
      provideInfo: id => ({ props: { inputActions: id === 'source' ? sourceActions : targetActions } }),
    },
    workspacesRuntime: { archiveSession: vi.fn(async () => {}), list: { getSnapshot: () => ({ items: [] }) }, insertSessionBefore: vi.fn() },
    resolveAttachments: () => undefined,
    resolveInput: id => id === 'source' ? sourceInput : targetInput,
  }
  const view = render(
    <section data-composer-seat>
      <div data-slot="conversation.hero.agentPreset">preset</div>
      <button type="button" aria-label="Send">send</button>
      <WorktreeModeSelect {...props} />
    </section>,
  )
  return { view, props, draft, sourceActions, targetActions, sourceInput, targetInput }
}

it('leaves the source draft intact when semantic capture is unavailable on a semantic-capable composer', async () => {
  const { view, props, sourceActions, targetActions } = transferSurface()
  props.resolveInput = () => undefined
  view.rerender(
    <section data-composer-seat>
      <div data-slot="conversation.hero.agentPreset">preset</div>
      <button type="button" aria-label="Send">send</button>
      <WorktreeModeSelect {...props} />
    </section>,
  )
  fireEvent.click(view.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(store.worktree.patch).toHaveBeenCalledWith('source', expect.objectContaining({ mode: 'local', phase: 'error', error: '无法读取消息引用草稿，请重试' })))
  expect(create).not.toHaveBeenCalled()
  expect(sourceActions.setDraft).not.toHaveBeenCalled()
  expect(sourceActions.persistDraft).not.toHaveBeenCalled()
  expect(targetActions.submit).not.toHaveBeenCalled()
})

it('transfers the captured semantic draft into the new worktree before submitting', async () => {
  const { view, draft, sourceActions, targetActions, targetInput } = transferSurface()
  fireEvent.click(view.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(targetActions.submit).toHaveBeenCalledOnce())
  expect(targetInput.setDraft).toHaveBeenCalledExactlyOnceWith(draft)
  expect(sourceActions.setDraft).toHaveBeenCalledExactlyOnceWith('')
  expect(sourceActions.persistDraft).toHaveBeenCalledOnce()
  expect(sourceActions.submit).not.toHaveBeenCalled()
})

it('restores the complete source draft when the target semantic import fails after switching', async () => {
  const { view, draft, sourceActions, targetActions, sourceInput, targetInput } = transferSurface()
  vi.mocked(targetInput.setDraft).mockImplementationOnce(() => {
    throw new Error('target disposed')
  })
  fireEvent.click(view.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(sourceInput.setDraft).toHaveBeenCalledExactlyOnceWith(draft))
  expect(sourceActions.persistDraft).toHaveBeenCalledTimes(2)
  expect(sourceActions.submit).not.toHaveBeenCalled()
  expect(targetActions.submit).not.toHaveBeenCalled()
  expect(store.worktree.patch).toHaveBeenCalledWith('source', expect.objectContaining({ mode: 'local', phase: 'error', error: 'target disposed' }))
})

it('moves one portal with the composer target, removes it when the target disappears, and cleans up on unmount', async () => {
  const props: ModeSelectProps = {
    sessionId: 'one',
    useInput(selector) {
      const [input] = useState({ draft: '' })
      return selector(input)
    },
    inputActions: { setDraft: vi.fn(), submit: vi.fn() },
    sessionsRuntime: {} as ModeSelectProps['sessionsRuntime'],
    workspacesRuntime: {} as ModeSelectProps['workspacesRuntime'],
    resolveAttachments: () => undefined,
  }
  function surface(sessionId: string, target: boolean) {
    return (
      <StrictMode>
        <section data-composer-seat>
          {target && <div data-slot="conversation.hero.agentPreset">preset</div>}
          <WorktreeModeSelect {...props} sessionId={sessionId} />
        </section>
      </StrictMode>
    )
  }
  const view = render(surface('one', true))
  const selector = '[data-dsh-tauri-worktree-mode]'
  const target = view.container.querySelector('[data-slot]')!
  const host = view.container.querySelector(selector)
  expect(host).not.toBeNull()
  expect(target.nextElementSibling).toBe(host)
  expect(host?.textContent).toBe('modeLocal')
  const sibling = document.createElement('span')
  await act(async () => {
    target.after(sibling)
  })
  await waitFor(() => expect(target.nextElementSibling).toBe(host))
  expect(view.container.querySelectorAll(selector)).toHaveLength(1)
  view.rerender(surface('two', true))
  expect(host?.isConnected).toBe(false)
  expect(view.container.querySelector(selector)?.getAttribute('data-dsh-tauri-worktree-mode')).toBe('two')
  view.rerender(surface('two', false))
  await waitFor(() => expect(view.container.querySelector(selector)).toBeNull())
  view.rerender(surface('two', true))
  await waitFor(() => expect(view.container.querySelector(selector)?.textContent).toBe('modeLocal'))
  const finalHost = view.container.querySelector(selector)!
  view.unmount()
  expect(finalHost.isConnected).toBe(false)
})
