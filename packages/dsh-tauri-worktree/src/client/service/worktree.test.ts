import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { postWorktree } from '../apis'
import { store } from '../store'
import { create } from './worktree'

vi.mock('dsh-tauri/client', async () => {
  const { get } = await import('lodash-es')
  return { get }
})
vi.mock('../apis', () => ({ postWorktree: vi.fn() }))
vi.mock('../locales', () => ({ locale: { text: (key: string) => key } }))
vi.mock('../store', () => ({ store: { worktree: { patch: vi.fn() } } }))

beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.restoreAllMocks())

const input = { sessionId: 'target', sourceSessionId: 'source', inherit: true }

it('returns the host inheritance error rather than the generic HTTP failure', async () => {
  vi.mocked(postWorktree).mockRejectedValue(Object.assign(new Error('[POST] /api/tauri/worktree: 500'), { data: { error: '会话历史继承失败：preset unavailable' } }))
  await expect(create(input)).resolves.toEqual({ ok: false, error: '会话历史继承失败：preset unavailable' })
  expect(store.worktree.patch).not.toHaveBeenCalled()
})

it('rejects an unsuccessful response without marking the target as a worktree', async () => {
  vi.mocked(postWorktree).mockResolvedValue({ error: '会话历史继承失败：session missing' })
  await expect(create(input)).resolves.toEqual({ ok: false, error: '会话历史继承失败：session missing' })
  expect(store.worktree.patch).not.toHaveBeenCalled()
})

it('marks a successfully inherited target as a worktree', async () => {
  const result = { ok: true, inherited: true, worktreePath: '/scratch/worktree' }
  vi.mocked(postWorktree).mockResolvedValue(result)
  await expect(create(input)).resolves.toEqual({ ok: true, result })
  expect(postWorktree).toHaveBeenCalledExactlyOnceWith(input)
  expect(store.worktree.patch).toHaveBeenCalledWith('target', expect.objectContaining({ mode: 'worktree', phase: 'created', worktreePath: '/scratch/worktree', error: '' }))
})
