// @vitest-environment jsdom
import type { SessionSummaryLike } from '../types'
import type { MenuComposer } from './context-menu.types'
import { afterEach, expect, it, vi } from 'vitest'
import { locale } from '../locales'
import { buildEditableMenu, buildSessionMenu } from './context-menu.menu'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('dsh-tauri/client', async importOriginal => ({
  ...await importOriginal<typeof import('dsh-tauri/client')>(),
  invoke,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  invoke.mockReset()
  document.body.replaceChildren()
})

function editableMenu() {
  const actions = new Map<string, () => unknown>()
  const composer = {
    add: (label: string, action: () => unknown) => actions.set(label, action),
    split: vi.fn(),
    toast: vi.fn(),
    copyText: vi.fn(),
  } as unknown as MenuComposer
  const editable = document.createElement('textarea')
  document.body.appendChild(editable)
  buildEditableMenu(composer, editable, '')
  return { actions, editable }
}

it('剪贴板没有文本时把文件/图片粘贴交给宿主垫片（issue #1190）', async () => {
  vi.stubGlobal('dshDesktop', {})
  invoke.mockResolvedValue(null)
  const paste = vi.fn().mockResolvedValue(true)
  vi.stubGlobal('__dsh_paste_clipboard__', paste)
  const { actions, editable } = editableMenu()

  await actions.get(locale.text('paste'))?.()

  expect(paste).toHaveBeenCalledExactlyOnceWith(editable)
  expect(document.activeElement).toBe(editable)
})

it('宿主垫片不在场且没有文本时保留原提示', async () => {
  vi.stubGlobal('dshDesktop', {})
  invoke.mockResolvedValue(null)
  const { actions } = editableMenu()

  await expect(actions.get(locale.text('paste'))?.()).rejects.toThrow()
})

it('宿主垫片未处理时同样保留原提示', async () => {
  vi.stubGlobal('dshDesktop', {})
  invoke.mockResolvedValue(null)
  vi.stubGlobal('__dsh_paste_clipboard__', vi.fn().mockResolvedValue(false))
  const { actions } = editableMenu()

  await expect(actions.get(locale.text('paste'))?.()).rejects.toThrow()
})

it('剪贴板有文本时只走文本粘贴，不再请求宿主垫片', async () => {
  vi.stubGlobal('dshDesktop', {})
  invoke.mockResolvedValue('hello')
  const paste = vi.fn().mockResolvedValue(true)
  vi.stubGlobal('__dsh_paste_clipboard__', paste)
  const { actions, editable } = editableMenu()

  await actions.get(locale.text('paste'))?.()

  expect(editable.value).toBe('hello')
  expect(paste).not.toHaveBeenCalled()
})

it('only offers a desktop window in the shell and targets the clicked session without selecting it', async () => {
  const actions = new Map<string, () => unknown>()
  const open = vi.fn()
  const composer = {
    add: (label: string, action: () => unknown) => actions.set(label, action),
    split: vi.fn(),
    sessions: { open },
    workspaces: {},
  } as unknown as MenuComposer
  const session = { id: 'clicked', title: 'Clicked session' } as SessionSummaryLike
  const row = document.createElement('div')
  buildSessionMenu(composer, row, session, null, [])
  expect(actions.has('Open in new window')).toBe(false)
  vi.stubGlobal('dshDesktop', {})
  actions.clear()
  buildSessionMenu(composer, row, session, null, [])
  expect([...actions.keys()].slice(-2)).toEqual(['Open in new window', 'Refresh'])
  await actions.get('Open in new window')?.()
  expect(invoke).toHaveBeenCalledWith('create_app_window', { sessionId: 'clicked' })
  expect(open).not.toHaveBeenCalled()
  invoke.mockRejectedValue(new Error('WINDOW_CREATE_FAILED'))
  await expect(actions.get('Open in new window')?.()).rejects.toThrow('WINDOW_CREATE_FAILED')
})
