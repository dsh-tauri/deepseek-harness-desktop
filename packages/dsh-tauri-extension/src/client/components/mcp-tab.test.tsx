// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getMcp, getMcpAuthorize, postMcpAuthorize, postMcpCheck } from '../apis'
import { McpTab } from './mcp-tab'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../apis', () => ({
  getMcp: vi.fn(),
  postMcpCheck: vi.fn(),
  postMcpAuthorize: vi.fn(),
  getMcpAuthorize: vi.fn(),
}))
vi.mock('dsh-tauri/client', () => ({ compact: (items: unknown[]) => items.filter(Boolean), invoke }))
vi.mock('../service/restart', () => ({ restartHost: vi.fn() }))
vi.mock('./mcp-editor-form', () => ({ McpEditorForm: () => null }))
vi.mock('./mcp-import-dialog', () => ({ McpImportDialog: () => null }))
vi.mock('dsh-tauri-ui/client', () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const Empty = () => null
  return {
    Action: Empty,
    ArrowRotateRight: Empty,
    Button: ({ children, disabled, onClick }: { children?: ReactNode, disabled?: boolean, onClick?: () => void }) => <button disabled={disabled} onClick={onClick}>{children}</button>,
    Card: Object.assign(({ children }: { children?: ReactNode }) => <article>{children}</article>, { List: Content, Title: Content, Description: Content }),
    Icon: Empty,
    Modal: Empty,
    PlugConnection: Empty,
    Select: Empty,
    Tag: Content,
    Text: Content,
    Toast: ({ text }: { text: string }) => <div role="status">{text}</div>,
    TriangleExclamation: Empty,
  }
})

const t = (key: string) => key
const remote = { id: 'same', serverName: 'remote', transport: 'streamable-http' as const, url: 'https://mcp.example.test', disabled: false }

beforeEach(() => {
  vi.mocked(getMcp).mockResolvedValue({ servers: [{ ...remote, scope: 'profile' }], restartNeeded: false })
  vi.mocked(postMcpCheck).mockResolvedValue({ ok: false, detail: 'authorization required', requiresAuth: true })
  vi.mocked(postMcpAuthorize).mockResolvedValue({ authorizationUrl: 'https://auth.example.test/authorize', attemptId: 'attempt-1' })
  vi.mocked(getMcpAuthorize).mockResolvedValue({ status: 'pending' })
  invoke.mockResolvedValue(undefined)
  Object.defineProperty(window, 'dshDesktop', { configurable: true, value: {} })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'dshDesktop')
})

it('silently probes remote rows using their scopes and changes only the authorized row back to Check', async () => {
  vi.mocked(getMcp).mockResolvedValue({ servers: [
    { ...remote, scope: 'global', serverName: 'global remote' },
    { ...remote, scope: 'profile', serverName: 'profile remote' },
    { id: 'local', serverName: 'local', transport: 'stdio', command: 'node', disabled: false },
  ], restartNeeded: false })
  render(<McpTab t={t} />)
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'authorizeLabel' })).toHaveLength(2))
  expect(postMcpCheck).toHaveBeenCalledTimes(2)
  expect(postMcpCheck).toHaveBeenCalledWith({ id: 'same', scope: 'global' })
  expect(postMcpCheck).toHaveBeenCalledWith({ id: 'same', scope: 'profile' })
  expect(screen.queryByRole('status')).toBeNull()
  const cards = screen.getAllByRole('article')
  vi.useFakeTimers()
  fireEvent.click(within(cards[1]).getByRole('button', { name: 'authorizeLabel' }))
  await act(async () => {})
  expect(postMcpAuthorize).toHaveBeenCalledWith({ id: 'same', scope: 'profile' })
  expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://auth.example.test/authorize' })
  await act(() => vi.advanceTimersByTimeAsync(1_500))
  expect(getMcpAuthorize).toHaveBeenCalledWith({ query: { attemptId: 'attempt-1' } })
  expect(within(cards[1]).getByRole('button', { name: 'authorizationRunning' }).hasAttribute('disabled')).toBe(true)
  vi.mocked(getMcpAuthorize).mockResolvedValue({ status: 'authorized' })
  await act(() => vi.advanceTimersByTimeAsync(1_500))
  expect(within(cards[0]).getByRole('button', { name: 'authorizeLabel' }).hasAttribute('disabled')).toBe(false)
  expect(within(cards[1]).getByRole('button', { name: 'checkLabel' }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('status').textContent).toBe('authorizationRestartNeeded')
  vi.mocked(postMcpCheck).mockResolvedValue({ ok: true, detail: 'connected' })
  fireEvent.click(within(cards[1]).getByRole('button', { name: 'checkLabel' }))
  await act(async () => {})
  expect(postMcpCheck).toHaveBeenLastCalledWith({ id: 'same', scope: 'profile' })
  expect(screen.getByRole('status').textContent).toBe('connectivityOk (connected)')
})

it('rejects non-HTTPS authorization URLs without opening the browser or polling', async () => {
  vi.mocked(postMcpAuthorize).mockResolvedValue({ authorizationUrl: 'javascript:alert(1)', attemptId: 'invalid' })
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  render(<McpTab t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: 'authorizeLabel' }))
  await screen.findByText('failed: authorizationUrlInvalid')
  expect(invoke).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(getMcpAuthorize).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'authorizeLabel' }).hasAttribute('disabled')).toBe(false)
})

it('keeps authorization available after a polling error and stops scheduling polls', async () => {
  render(<McpTab t={t} />)
  const button = await screen.findByRole('button', { name: 'authorizeLabel' })
  vi.useFakeTimers()
  vi.mocked(getMcpAuthorize).mockResolvedValue({ status: 'error', error: 'access denied' })
  fireEvent.click(button)
  await act(async () => {})
  await act(() => vi.advanceTimersByTimeAsync(1_500))
  expect(screen.getByRole('status').textContent).toBe('failed: access denied')
  expect(screen.getByRole('button', { name: 'authorizeLabel' }).hasAttribute('disabled')).toBe(false)
  await act(() => vi.advanceTimersByTimeAsync(300_000))
  expect(getMcpAuthorize).toHaveBeenCalledTimes(1)
})

it('opens a detached browser window synchronously before navigating to the validated authorization URL', async () => {
  Reflect.deleteProperty(window, 'dshDesktop')
  const browser = { opener: window, location: { href: 'about:blank' }, close: vi.fn() }
  const open = vi.spyOn(window, 'open').mockReturnValue(browser as unknown as Window)
  render(<McpTab t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: 'authorizeLabel' }))
  expect(open).toHaveBeenCalledWith('about:blank', '_blank')
  expect(browser.opener).toBeNull()
  await waitFor(() => expect(browser.location.href).toBe('https://auth.example.test/authorize'))
  expect(invoke).not.toHaveBeenCalled()
})

it('restores the authorization button when pending authorization reaches its deadline', async () => {
  render(<McpTab t={t} />)
  const button = await screen.findByRole('button', { name: 'authorizeLabel' })
  vi.useFakeTimers()
  fireEvent.click(button)
  await act(async () => {})
  await act(() => vi.advanceTimersByTimeAsync(300_000))
  expect(screen.getByRole('status').textContent).toBe('failed: authorizationTimeout')
  expect(screen.getByRole('button', { name: 'authorizeLabel' }).hasAttribute('disabled')).toBe(false)
  const count = vi.mocked(getMcpAuthorize).mock.calls.length
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect(getMcpAuthorize).toHaveBeenCalledTimes(count)
})

it('lets a failed silent probe be retried with Check without showing a load-time error', async () => {
  vi.mocked(postMcpCheck).mockRejectedValueOnce(new Error('offline'))
  render(<McpTab t={t} />)
  const button = await screen.findByRole('button', { name: 'checkLabel' })
  expect(button.hasAttribute('disabled')).toBe(false)
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(button)
  await screen.findByRole('button', { name: 'authorizeLabel' })
  expect(postMcpCheck).toHaveBeenCalledTimes(2)
})

it('surfaces an authorization attempt lookup error instead of continuing to poll', async () => {
  render(<McpTab t={t} />)
  const button = await screen.findByRole('button', { name: 'authorizeLabel' })
  vi.useFakeTimers()
  vi.mocked(getMcpAuthorize).mockResolvedValue({ error: 'attempt not found' })
  fireEvent.click(button)
  await act(async () => {})
  await act(() => vi.advanceTimersByTimeAsync(1_500))
  expect(screen.getByRole('status').textContent).toBe('failed: attempt not found')
  expect(screen.getByRole('button', { name: 'authorizeLabel' }).hasAttribute('disabled')).toBe(false)
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect(getMcpAuthorize).toHaveBeenCalledTimes(1)
})

it('cancels pending authorization polling when the component unmounts', async () => {
  const view = render(<McpTab t={t} />)
  const button = await screen.findByRole('button', { name: 'authorizeLabel' })
  vi.useFakeTimers()
  fireEvent.click(button)
  await act(async () => {})
  view.unmount()
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect(getMcpAuthorize).not.toHaveBeenCalled()
})
