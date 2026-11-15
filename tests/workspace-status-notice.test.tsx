// @vitest-environment jsdom
import type { SessionId } from 'dsh-tauri/client'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { postSessionWorkspaceStatus } from '../packages/builtin-plugin-ui/src/client/apis'
import { WorkspaceStatusNotice } from '../packages/builtin-plugin-ui/src/client/ui/workspace-status-notice'

vi.mock('../packages/builtin-plugin-ui/src/client/apis', () => ({
  postSessionWorkspaceStatus: vi.fn(),
}))

const probe = vi.mocked(postSessionWorkspaceStatus)
const sessionId = 'session-test' as SessionId

afterEach(() => {
  cleanup()
  probe.mockReset()
})

it('shows the unavailable path and clears it after recovery on focus', async () => {
  const cwd = '/projects/moved'
  probe.mockResolvedValueOnce({ status: 'missing', cwd })
  probe.mockResolvedValueOnce({ status: 'available' })
  render(<WorkspaceStatusNotice sessionId={sessionId} chooseFolder={async () => ({ status: 'cancelled' })} />)

  expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining(cwd))

  fireEvent.focus(window)
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
})

it('clears the old warning when another chat is selected', async () => {
  probe.mockResolvedValueOnce({ status: 'missing', cwd: '/projects/moved' })
  probe.mockResolvedValueOnce({ status: 'available' })
  const chooseFolder = async () => ({ status: 'cancelled' })
  const { rerender } = render(<WorkspaceStatusNotice sessionId={sessionId} chooseFolder={chooseFolder} />)
  await screen.findByRole('status')

  rerender(<WorkspaceStatusNotice sessionId={'session-other' as SessionId} chooseFolder={chooseFolder} />)

  expect(screen.queryByRole('status')).toBeNull()
})

it('opens the folder picker only when the user chooses to start a new chat', async () => {
  probe.mockResolvedValue({ status: 'not-directory', cwd: '/projects/replaced' })
  const chooseFolder = vi.fn(async () => ({ status: 'cancelled' }))
  render(<WorkspaceStatusNotice sessionId={sessionId} chooseFolder={chooseFolder} />)

  const button = await screen.findByRole('button', { name: 'Choose a folder for a new chat' })
  expect(chooseFolder).not.toHaveBeenCalled()
  fireEvent.click(button)
  expect(chooseFolder).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(button).toHaveProperty('disabled', false))
})
