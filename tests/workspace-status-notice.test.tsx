// @vitest-environment jsdom
import type { SessionId } from 'dsh-tauri/client'
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { postSessionWorkspaceStatus } from '../packages/builtin-plugin-ui/src/client/apis'
import { registerWorkspaceStatus } from '../packages/builtin-plugin-ui/src/client/register/workspace-status'
import { WorkspaceStatusNotice } from '../packages/builtin-plugin-ui/src/client/ui/workspace-status-notice'

vi.mock('../packages/builtin-plugin-ui/src/client/apis', () => ({
  postSessionWorkspaceStatus: vi.fn(),
}))

const probe = vi.mocked(postSessionWorkspaceStatus)
const sessionId = 'session-test' as SessionId
type NoticeBindings = Omit<ComponentProps<typeof WorkspaceStatusNotice>, 'sessionId'>
let disposeRegistration: (() => void) | undefined

function registerNotice(): NoticeBindings {
  let bindings: NoticeBindings | undefined
  vi.stubGlobal('dshDesktop', { protocolVersion: 1 })
  disposeRegistration = registerWorkspaceStatus.call({
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: ({ inject }: { inject: () => NoticeBindings }) => {
        bindings = inject()
        return () => {}
      },
    },
  })
  if (!bindings)
    throw new Error('Workspace notice was not registered')
  return bindings
}

afterEach(() => {
  cleanup()
  disposeRegistration?.()
  disposeRegistration = undefined
  probe.mockReset()
  vi.unstubAllGlobals()
})

it('shows the unavailable path and clears it after recovery on focus', async () => {
  const cwd = '/projects/moved'
  probe.mockResolvedValueOnce({ status: 'missing', cwd })
  probe.mockResolvedValueOnce({ status: 'available' })
  render(<WorkspaceStatusNotice sessionId={sessionId} {...registerNotice()} />)

  expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining(cwd))

  fireEvent.focus(window)
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
})

it('clears the old warning when another chat is selected', async () => {
  probe.mockResolvedValueOnce({ status: 'missing', cwd: '/projects/moved' })
  probe.mockResolvedValueOnce({ status: 'available' })
  const bindings = registerNotice()
  const { rerender } = render(<WorkspaceStatusNotice sessionId={sessionId} {...bindings} />)
  await screen.findByRole('status')

  rerender(<WorkspaceStatusNotice sessionId={'session-other' as SessionId} {...bindings} />)

  expect(screen.queryByRole('status')).toBeNull()
})

it('opens the folder picker only when the user chooses to start a new chat', async () => {
  probe.mockResolvedValue({ status: 'not-directory', cwd: '/projects/replaced' })
  const chooseFolder = vi.fn(async () => ({ status: 'cancelled' }))
  render(<WorkspaceStatusNotice sessionId={sessionId} {...registerNotice()} chooseFolder={chooseFolder} />)

  const button = await screen.findByRole('button', { name: 'Choose a folder for a new chat' })
  expect(chooseFolder).not.toHaveBeenCalled()
  fireEvent.click(button)
  expect(chooseFolder).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(button).toHaveProperty('disabled', false))
})

it('stops probing on window focus when the plugin registration is disposed', async () => {
  probe.mockResolvedValue({ status: 'missing', cwd: '/projects/moved' })
  render(<WorkspaceStatusNotice sessionId={sessionId} {...registerNotice()} />)
  await screen.findByRole('status')

  disposeRegistration?.()
  fireEvent.focus(window)

  expect(probe).toHaveBeenCalledTimes(1)
})
