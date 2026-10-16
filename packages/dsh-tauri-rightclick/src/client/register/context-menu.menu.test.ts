// @vitest-environment jsdom
import type { SessionSummaryLike } from '../types'
import type { MenuComposer } from './context-menu.types'
import { afterEach, expect, it, vi } from 'vitest'
import { buildSessionMenu } from './context-menu.menu'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('dsh-tauri/client', async importOriginal => ({
  ...await importOriginal<typeof import('dsh-tauri/client')>(),
  invoke,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  invoke.mockReset()
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
  expect(invoke).toHaveBeenCalledWith('create_app_window', { sessionId: 'clicked', iframeUrl: window.location.origin })
  expect(open).not.toHaveBeenCalled()
  invoke.mockRejectedValue(new Error('WINDOW_CREATE_FAILED'))
  await expect(actions.get('Open in new window')?.()).rejects.toThrow('WINDOW_CREATE_FAILED')
})
